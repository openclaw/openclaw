---
summary: "Analyse approfondie : magasin de sessions + transcriptions, cycle de vie et fonctionnement interne de la (auto)compaction"
read_when:
  - Vous devez deboguer les identifiants de session, le JSONL des transcriptions ou les champs de sessions.json
  - Vous modifiez le comportement de l’auto-compaction ou ajoutez du nettoyage « pre-compaction »
  - Vous voulez implementer des vidages de memoire ou des tours systeme silencieux
title: "Analyse approfondie de la gestion des sessions"
---

# Gestion des sessions et compaction (analyse approfondie)

Ce document explique comment OpenClaw gere les sessions de bout en bout :

- **Routage des sessions** (comment les messages entrants correspondent a un `sessionKey`)
- **Magasin de sessions** (`sessions.json`) et ce qu’il suit
- **Persistance des transcriptions** (`*.jsonl`) et leur structure
- **Hygiene des transcriptions** (correctifs specifiques au fournisseur avant les executions)
- **Limites de contexte** (fenetre de contexte vs jetons suivis)
- **Compaction** (compaction manuelle + automatique) et ou brancher le travail pre-compaction
- **Maintenance silencieuse** (par ex. ecritures de memoire qui ne doivent pas produire de sortie visible pour l’utilisateur)

Si vous voulez d’abord une vue d’ensemble de plus haut niveau, commencez par :

- [/concepts/session](/concepts/session)
- [/concepts/compaction](/concepts/compaction)
- [/concepts/session-pruning](/concepts/session-pruning)
- [/reference/transcript-hygiene](/reference/transcript-hygiene)

---

## Source de verite : la Gateway (passerelle)

OpenClaw est concu autour d’un **processus Gateway unique** qui possede l’etat des sessions.

- Les IU (application macOS, interface web Control, TUI) doivent interroger la Gateway pour les listes de sessions et les comptes de jetons.
- En mode distant, les fichiers de session se trouvent sur l’hote distant ; « verifier vos fichiers locaux sur le Mac » ne refletera pas ce que la Gateway utilise.

---

## Deux couches de persistance

OpenClaw persiste les sessions en deux couches :

1. **Magasin de sessions (`sessions.json`)**
   - Carte cle/valeur : `sessionKey -> SessionEntry`
   - Petit, mutable, sans danger a modifier (ou a supprimer des entrees)
   - Suit les metadonnees de session (identifiant de session courant, derniere activite, bascules, compteurs de jetons, etc.)

2. **Transcription (`<sessionId>.jsonl`)**
   - Transcription en ajout seul avec structure arborescente (les entrees ont `id` + `parentId`)
   - Stocke la conversation reelle + les appels d’outils + les resumes de compaction
   - Utilisee pour reconstruire le contexte du modele pour les tours futurs

---

## Emplacements sur disque

Par agent, sur l’hote de la Gateway :

- Magasin : `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- Transcriptions : `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
  - Sessions de sujets Telegram : `.../<sessionId>-topic-<threadId>.jsonl`

OpenClaw les resout via `src/config/sessions.ts`.

---

## Cles de session (`sessionKey`)

Une `sessionKey` identifie _quel compartiment de conversation_ vous utilisez (routage + isolation).

Modèles communs:

- Discussion principale/directe (par agent) : `agent:<agentId>:<mainKey>` (par defaut `main`)
- Groupe : `agent:<agentId>:<channel>:group:<id>`
- Salle/canal (Discord/Slack) : `agent:<agentId>:<channel>:channel:<id>` ou `...:room:<id>`
- Cron : `cron:<job.id>`
- Webhook : `hook:<uuid>` (sauf remplacement)

Les regles canoniques sont documentees sur [/concepts/session](/concepts/session).

---

## Identifiants de session (`sessionId`)

Chaque `sessionKey` pointe vers un `sessionId` courant (le fichier de transcription qui poursuit la conversation).

Regles empiriques :

- **Reinitialisation** (`/new`, `/reset`) cree un nouvel `sessionId` pour cette `sessionKey`.
- **Reinitialisation quotidienne** (par defaut a 4 h 00 heure locale sur l’hote de la Gateway) cree un nouvel `sessionId` au message suivant apres la limite de reinitialisation.
- **Expiration d’inactivite** (`session.reset.idleMinutes` ou l’heritage `session.idleMinutes`) cree un nouvel `sessionId` lorsqu’un message arrive apres la fenetre d’inactivite. Lorsque quotidien + inactivite sont tous deux configures, celui qui expire en premier l’emporte.

Detail d’implementation : la decision se fait dans `initSessionState()` dans `src/auto-reply/reply/session.ts`.

---

## Schema du magasin de sessions (`sessions.json`)

Le type de valeur du magasin est `SessionEntry` dans `src/config/sessions.ts`.

Champs cles (liste non exhaustive) :

- `sessionId` : identifiant de transcription courant (le nom de fichier en est derive sauf si `sessionFile` est defini)
- `updatedAt` : horodatage de la derniere activite
- `sessionFile` : remplacement explicite optionnel du chemin de transcription
- `chatType` : `direct | group | room` (aide les IU et la politique d’envoi)
- `provider`, `subject`, `room`, `space`, `displayName` : metadonnees pour l’etiquetage de groupe/canal
- Toggles:
  - `thinkingLevel`, `verboseLevel`, `reasoningLevel`, `elevatedLevel`
  - `sendPolicy` (remplacement par session)
- Selection du modele :
  - `providerOverride`, `modelOverride`, `authProfileOverride`
- Compteurs de jetons (au mieux / dependants du fournisseur) :
  - `inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`
- `compactionCount` : frequence a laquelle l’auto-compaction s’est terminee pour cette cle de session
- `memoryFlushAt` : horodatage du dernier vidage de memoire pre-compaction
- `memoryFlushCompactionCount` : nombre de compactions lorsque le dernier vidage a ete execute

Le magasin peut etre modifie en toute securite, mais la Gateway fait autorite : elle peut reecrire ou rehydrater des entrees a mesure que les sessions s’executent.

---

## Structure des transcriptions (`*.jsonl`)

Les transcriptions sont gerees par le `SessionManager` de `@mariozechner/pi-coding-agent`.

Le fichier est en JSONL :

- Premiere ligne : en-tete de session (`type: "session"`, inclut `id`, `cwd`, `timestamp`, `parentSession` optionnel)
- Puis : entrees de session avec `id` + `parentId` (arbre)

Types d’entrees notables :

- `message` : messages utilisateur/assistant/toolResult
- `custom_message` : messages injectes par des extensions qui _entrent_ dans le contexte du modele (peuvent etre masques de l’IU)
- `custom` : etat d’extension qui n’entre _pas_ dans le contexte du modele
- `compaction` : resume de compaction persiste avec `firstKeptEntryId` et `tokensBefore`
- `branch_summary` : resume persiste lors de la navigation dans une branche de l’arbre

OpenClaw ne « corrige » intentionnellement **pas** les transcriptions ; la Gateway utilise `SessionManager` pour les lire/ecrire.

---

## Fenetres de contexte vs jetons suivis

Deux concepts differents comptent :

1. **Fenetre de contexte du modele** : plafond strict par modele (jetons visibles par le modele)
2. **Compteurs du magasin de sessions** : statistiques glissantes ecrites dans `sessions.json` (utilisees pour /status et les tableaux de bord)

Si vous ajustez les limites :

- La fenetre de contexte provient du catalogue de modeles (et peut etre remplacee via la configuration).
- `contextTokens` dans le magasin est une valeur d’estimation/de rapport a l’execution ; ne la traitez pas comme une garantie stricte.

Pour plus d’informations, voir [/token-use](/token-use).

---

## Compaction : ce que c’est

La compaction resume les conversations plus anciennes dans une entree `compaction` persistee dans la transcription et conserve les messages recents intacts.

Apres compaction, les tours futurs voient :

- Le resume de compaction
- Les messages apres `firstKeptEntryId`

La compaction est **persistante** (contrairement a l’elimination de sessions). Voir [/concepts/session-pruning](/concepts/session-pruning).

---

## Quand l’auto-compaction se produit (runtime Pi)

Dans l’agent Pi embarque, l’auto-compaction se declenche dans deux cas :

1. **Recuperation apres depassement** : le modele renvoie une erreur de depassement de contexte → compacter → reessayer.
2. **Maintenance par seuil** : apres un tour reussi, lorsque :

`contextTokens > contextWindow - reserveTokens`

Où :

- `contextWindow` est la fenetre de contexte du modele
- `reserveTokens` est la marge reservee pour les invites + la sortie du modele suivante

Ce sont des semantiques du runtime Pi (OpenClaw consomme les evenements, mais Pi decide quand compacter).

---

## Parametres de compaction (`reserveTokens`, `keepRecentTokens`)

Les parametres de compaction de Pi se trouvent dans les parametres Pi :

```json5
{
  compaction: {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  },
}
```

OpenClaw impose egalement un plancher de securite pour les executions embarquees :

- Si `compaction.reserveTokens < reserveTokensFloor`, OpenClaw l’augmente.
- Le plancher par defaut est de `20000` jetons.
- Definissez `agents.defaults.compaction.reserveTokensFloor: 0` pour desactiver le plancher.
- S’il est deja plus eleve, OpenClaw le laisse tel quel.

Pourquoi : laisser suffisamment de marge pour des « taches de maintenance » multi-tours (comme les ecritures de memoire) avant que la compaction ne devienne ineluctable.

Implementation : `ensurePiCompactionReserveTokens()` dans `src/agents/pi-settings.ts`
(appelé depuis `src/agents/pi-embedded-runner.ts`).

---

## Surfaces visibles par l’utilisateur

Vous pouvez observer la compaction et l’etat des sessions via :

- `/status` (dans toute session de discussion)
- `openclaw status` (CLI)
- `openclaw sessions` / `sessions --json`
- Mode verbeux : `🧹 Auto-compaction complete` + nombre de compactions

---

## Maintenance silencieuse (`NO_REPLY`)

OpenClaw prend en charge les tours « silencieux » pour les taches en arriere-plan ou l’utilisateur ne doit pas voir de sortie intermediaire.

Convention :

- L’assistant commence sa sortie par `NO_REPLY` pour indiquer « ne pas livrer de reponse a l’utilisateur ».
- OpenClaw supprime/masque cela dans la couche de livraison.

Depuis `2026.1.10`, OpenClaw supprime egalement le **streaming brouillon/frappe** lorsqu’un fragment partiel commence par `NO_REPLY`, afin que les operations silencieuses ne divulguent pas de sortie partielle en cours de tour.

---

## « Vidage de memoire » pre-compaction (implante)

Objectif : avant que l’auto-compaction ne se produise, executer un tour agentique silencieux qui ecrit un etat durable sur disque (par ex. `memory/YYYY-MM-DD.md` dans l’espace de travail de l’agent) afin que la compaction ne puisse pas effacer un contexte critique.

OpenClaw utilise l’approche **vidage avant seuil** :

1. Surveiller l’utilisation du contexte de session.
2. Lorsqu’elle franchit un « seuil souple » (inferieur au seuil de compaction de Pi), executer une directive silencieuse « ecrire la memoire maintenant » a l’agent.
3. Utiliser `NO_REPLY` pour que l’utilisateur ne voie rien.

Configuration (`agents.defaults.compaction.memoryFlush`) :

- `enabled` (par defaut : `true`)
- `softThresholdTokens` (par defaut : `4000`)
- `prompt` (message utilisateur pour le tour de vidage)
- `systemPrompt` (invite systeme supplementaire ajoutee pour le tour de vidage)

Notes :

- L'invite par défaut/système contient un indice `NO_REPLY` pour supprimer la livraison.
- Le vidage s’execute une fois par cycle de compaction (suivi dans `sessions.json`).
- Le vidage ne s’execute que pour les sessions Pi embarquees (les backends CLI l’ignorent).
- Le vidage est ignore lorsque l’espace de travail de la session est en lecture seule (`workspaceAccess: "ro"` ou `"none"`).
- Voir [Memory](/concepts/memory) pour la disposition des fichiers de l’espace de travail et les modeles d’ecriture.

Pi expose egalement un hook `session_before_compact` dans l’API d’extension, mais la logique de vidage d’OpenClaw reside aujourd’hui du cote de la Gateway.

---

## Liste de verification de depannage

- Cle de session incorrecte ? Commencez par [/concepts/session](/concepts/session) et confirmez le `sessionKey` dans `/status`.
- Incoherence magasin vs transcription ? Confirmez l’hote de la Gateway et le chemin du magasin depuis `openclaw status`.
- Spam de compaction ? Verifiez :
  - la fenetre de contexte du modele (trop petite)
  - les parametres de compaction (`reserveTokens` trop eleve pour la fenetre du modele peut provoquer une compaction plus precoce)
  - l’encombrement des resultats d’outils : activez/ajustez l’elimination de sessions
- Tours silencieux qui fuient ? Confirmez que la reponse commence par `NO_REPLY` (jeton exact) et que vous utilisez une version incluant le correctif de suppression du streaming.
