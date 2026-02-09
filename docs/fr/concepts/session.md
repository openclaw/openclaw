---
summary: "Regles de gestion des sessions, cles et persistance pour les conversations"
read_when:
  - Modification de la gestion ou du stockage des sessions
title: "Gestion des sessions"
---

# Gestion des sessions

OpenClaw traite **une session de discussion directe par agent** comme principale. Les discussions directes se replient sur `agent:<agentId>:<mainKey>` (par defaut `main`), tandis que les discussions de groupe/canal obtiennent leurs propres cles. `session.mainKey` est respecte.

Utilisez `session.dmScope` pour controler la facon dont les **messages prives** sont regroupes :

- `main` (par defaut) : tous les MP partagent la session principale pour la continuite.
- `per-peer` : isolement par identifiant d’expediteur a travers les canaux.
- `per-channel-peer` : isolement par canal + expediteur (recommande pour les boites de reception multi-utilisateurs).
- `per-account-channel-peer` : isolement par compte + canal + expediteur (recommande pour les boites de reception multi-comptes).
  Utilisez `session.identityLinks` pour mapper des identifiants de pairs prefixes par fournisseur vers une identite canonique afin que la meme personne partage une session de MP a travers les canaux lors de l’utilisation de `per-peer`, `per-channel-peer` ou `per-account-channel-peer`.

## Mode MP securise (recommande pour les configurations multi-utilisateurs)

> **Avertissement de securite :** si votre agent peut recevoir des MP de **plusieurs personnes**, vous devriez fortement envisager d’activer le mode MP securise. Sans cela, tous les utilisateurs partagent le meme contexte de conversation, ce qui peut entrainer des fuites d’informations privees entre utilisateurs.

**Exemple du probleme avec les parametres par defaut :**

- Alice (`<SENDER_A>`) envoie un message a votre agent au sujet d’un sujet prive (par exemple, un rendez-vous medical)
- Bob (`<SENDER_B>`) envoie un message a votre agent en demandant « De quoi parlions-nous ? »
- Comme les deux MP partagent la meme session, le modele peut repondre a Bob en utilisant le contexte precedent d’Alice.

**La solution :** definissez `dmScope` pour isoler les sessions par utilisateur :

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // Secure DM mode: isolate DM context per channel + sender.
    dmScope: "per-channel-peer",
  },
}
```

**Quand activer ceci :**

- Vous avez des approbations de jumelage pour plus d’un expediteur
- Vous utilisez une liste d’autorisation de MP avec plusieurs entrees
- Vous definissez `dmPolicy: "open"`
- Plusieurs numeros de telephone ou comptes peuvent envoyer des messages a votre agent

Remarques :

- La valeur par defaut est `dmScope: "main"` pour la continuite (tous les MP partagent la session principale). Cela convient aux configurations mono-utilisateur.
- Pour les boites de reception multi-comptes sur le meme canal, preferez `per-account-channel-peer`.
- Si la meme personne vous contacte sur plusieurs canaux, utilisez `session.identityLinks` pour regrouper ses sessions de MP en une identite canonique.
- Vous pouvez verifier vos parametres de MP avec `openclaw security audit` (voir [security](/cli/security)).

## Le Gateway (passerelle) est la source de verite

Tout l’etat des sessions est **detenu par la gateway** (le OpenClaw « maitre »). Les clients UI (application macOS, WebChat, etc.) doivent interroger la gateway pour les listes de sessions et les comptes de tokens au lieu de lire des fichiers locaux.

- En **mode distant**, le stockage des sessions qui vous concerne reside sur l’hote de la gateway distante, pas sur votre Mac.
- Les comptes de tokens affiches dans les UI proviennent des champs de stockage de la gateway (`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`). Les clients n’analysent pas les transcriptions JSONL pour « corriger » les totaux.

## Où se trouve l'État

- Sur l’**hote de la gateway** :
  - Fichier de stockage : `~/.openclaw/agents/<agentId>/sessions/sessions.json` (par agent).
- Transcriptions : `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl` (les sessions de sujets Telegram utilisent `.../<SessionId>-topic-<threadId>.jsonl`).
- Le stockage est une carte `sessionKey -> { sessionId, updatedAt, ... }`. Supprimer des entrees est sans risque ; elles sont recreees a la demande.
- Les entrees de groupe peuvent inclure `displayName`, `channel`, `subject`, `room` et `space` pour etiqueter les sessions dans les UI.
- Les entrees de session incluent des metadonnees `origin` (etiquette + indications de routage) afin que les UI puissent expliquer l’origine d’une session.
- OpenClaw ne lit **pas** les dossiers de session Pi/Tau historiques.

## Elagage des sessions

OpenClaw tronque par defaut les **anciens resultats d’outils** du contexte en memoire juste avant les appels LLM.
Cela ne **reecrit pas** l’historique JSONL. Voir [/concepts/session-pruning](/concepts/session-pruning).

## Vidage de memoire avant compaction

Lorsqu’une session approche de l’auto-compaction, OpenClaw peut executer un **vidage de memoire silencieux**
qui rappelle au modele d’ecrire des notes durables sur le disque. Cela ne s’execute que lorsque
l’espace de travail est accessible en ecriture. Voir [Memory](/concepts/memory) et
[Compaction](/concepts/compaction).

## Mappage des transports → cles de session

- Les discussions directes suivent `session.dmScope` (par defaut `main`).
  - `main` : `agent:<agentId>:<mainKey>` (continuite entre appareils/canaux).
    - Plusieurs numeros de telephone et canaux peuvent etre mappes vers la meme cle principale d’agent ; ils agissent comme des transports vers une seule conversation.
  - `per-peer` : `agent:<agentId>:dm:<peerId>`.
  - `per-channel-peer` : `agent:<agentId>:<channel>:dm:<peerId>`.
  - `per-account-channel-peer` : `agent:<agentId>:<channel>:<accountId>:dm:<peerId>` (accountId par defaut a `default`).
  - Si `session.identityLinks` correspond a un identifiant de pair prefixe par fournisseur (par exemple `telegram:123`), la cle canonique remplace `<peerId>` afin que la meme personne partage une session a travers les canaux.
- Les discussions de groupe isolent l’etat : `agent:<agentId>:<channel>:group:<id>` (les salles/canaux utilisent `agent:<agentId>:<channel>:channel:<id>`).
  - Les sujets de forum Telegram ajoutent `:topic:<threadId>` a l’identifiant de groupe pour l’isolement.
  - Les cles historiques `group:<id>` sont toujours reconnues pour la migration.
- Les contextes entrants peuvent encore utiliser `group:<id>` ; le canal est deduit de `Provider` et normalise vers la forme canonique `agent:<agentId>:<channel>:group:<id>`.
- Autres sources :
  - Taches cron : `cron:<job.id>`
  - Webhooks : `hook:<uuid>` (sauf si explicitement defini par le hook)
  - Executions de nœud : `node-<nodeId>`

## Cycle de vie

- Politique de reinitialisation : les sessions sont reutilisees jusqu’a expiration, et l’expiration est evaluee au prochain message entrant.
- Reinitialisation quotidienne : par defaut **4:00 du matin, heure locale de l’hote de la gateway**. Une session est perimee des que sa derniere mise a jour est anterieure a la derniere heure de reinitialisation quotidienne.
- Reinitialisation par inactivite (optionnelle) : `idleMinutes` ajoute une fenetre glissante d’inactivite. Lorsque la reinitialisation quotidienne et celle par inactivite sont configurees, **celle qui expire en premier** force une nouvelle session.
- Mode historique inactivite seule : si vous definissez `session.idleMinutes` sans aucune configuration `session.reset`/`resetByType`, OpenClaw reste en mode inactivite seule pour la retrocompatibilite.
- Remplacements par type (optionnels) : `resetByType` vous permet de remplacer la politique pour les sessions `dm`, `group` et `thread` (thread = fils Slack/Discord, sujets Telegram, fils Matrix lorsqu’ils sont fournis par le connecteur).
- Remplacements par canal (optionnels) : `resetByChannel` remplace la politique de reinitialisation pour un canal (s’applique a tous les types de session pour ce canal et a priorite sur `reset`/`resetByType`).
- Declencheurs de reinitialisation : les `/new` ou `/reset` exacts (plus tout supplement dans `resetTriggers`) demarrent un nouvel identifiant de session et transmettent le reste du message. `/new <model>` accepte un alias de modele, `provider/model` ou un nom de fournisseur (correspondance approximative) pour definir le nouveau modele de session. Si `/new` ou `/reset` est envoye seul, OpenClaw execute un court tour de salutation « hello » pour confirmer la reinitialisation.
- Reinitialisation manuelle : supprimez des cles specifiques du stockage ou retirez la transcription JSONL ; le message suivant les recree.
- Les taches cron isolees generent toujours un nouveau `sessionId` a chaque execution (pas de reutilisation par inactivite).

## Politique d’envoi (optionnelle)

Bloquez la livraison pour des types de session specifiques sans lister des identifiants individuels.

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
      ],
      default: "allow",
    },
  },
}
```

Remplacement a l’execution (proprietaire uniquement) :

- `/send on` → autoriser pour cette session
- `/send off` → refuser pour cette session
- `/send inherit` → effacer le remplacement et utiliser les regles de configuration
  Envoyez-les comme messages autonomes afin qu’ils soient pris en compte.

## Configuration (exemple de renommage optionnel)

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    scope: "per-sender", // keep group keys separate
    dmScope: "main", // DM continuity (set per-channel-peer/per-account-channel-peer for shared inboxes)
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      // Defaults: mode=daily, atHour=4 (gateway host local time).
      // If you also set idleMinutes, whichever expires first wins.
      mode: "daily",
      atHour: 4,
      idleMinutes: 120,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      dm: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetByChannel: {
      discord: { mode: "idle", idleMinutes: 10080 },
    },
    resetTriggers: ["/new", "/reset"],
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    mainKey: "main",
  },
}
```

## Inspection

- `openclaw status` — affiche le chemin du stockage et les sessions recentes.
- `openclaw sessions --json` — deverse chaque entree (filtrez avec `--active <minutes>`).
- `openclaw gateway call sessions.list --params '{}'` — recupere les sessions depuis la gateway en cours d’execution (utilisez `--url`/`--token` pour l’acces a une gateway distante).
- Envoyez `/status` comme message autonome dans le chat pour voir si l’agent est joignable, quelle part du contexte de session est utilisee, les bascules de raisonnement/verbosite actuelles, et quand vos identifiants WhatsApp web ont ete rafraichis pour la derniere fois (utile pour detecter les besoins de reconnexion).
- Envoyez `/context list` ou `/context detail` pour voir ce qui se trouve dans l’invite systeme et les fichiers d’espace de travail injectes (ainsi que les principaux contributeurs au contexte).
- Envoyez `/stop` comme message autonome pour interrompre l’execution en cours, vider les suivis en file d’attente pour cette session et arreter toute execution de sous-agents engendree (la reponse inclut le nombre arrete).
- Envoyez `/compact` (instructions optionnelles) comme message autonome pour resumer l’ancien contexte et liberer de l’espace de fenetre. Voir [/concepts/compaction](/concepts/compaction).
- Les transcriptions JSONL peuvent etre ouvertes directement pour examiner les tours complets.

## Conseils

- Gardez la cle principale dediee au trafic 1:1 ; laissez les groupes conserver leurs propres cles.
- Lors de l’automatisation du nettoyage, supprimez des cles individuelles plutot que l’ensemble du stockage afin de preserver le contexte ailleurs.

## Metadonnees d’origine de session

Chaque entree de session enregistre son origine (au mieux) dans `origin` :

- `label` : etiquette humaine (resolue a partir de l’etiquette de conversation + sujet de groupe/canal)
- `provider` : identifiant de canal normalise (y compris les extensions)
- `from`/`to` : identifiants de routage bruts provenant de l’enveloppe entrante
- `accountId` : identifiant de compte fournisseur (en multi-comptes)
- `threadId` : identifiant de fil/sujet lorsque le canal le prend en charge
  Les champs d’origine sont renseignes pour les messages directs, canaux et groupes. Si un
  connecteur ne met a jour que le routage de livraison (par exemple, pour maintenir a jour une session principale de MP),
  il doit tout de meme fournir le contexte entrant afin que la session conserve ses
  metadonnees explicatives. Les extensions peuvent le faire en envoyant `ConversationLabel`,
  `GroupSubject`, `GroupChannel`, `GroupSpace` et `SenderName` dans le contexte entrant
  et en appelant `recordSessionMetaFromInbound` (ou en transmettant le meme contexte
  a `updateLastRoute`).
