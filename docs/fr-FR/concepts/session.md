---
summary: "Règles de gestion des sessions, clés et persistance pour les chats"
read_when:
  - Vous modifiez la gestion ou le stockage des sessions
title: "Gestion des sessions"
---

# Gestion des sessions

OpenClaw traite **une session de chat direct par agent** comme principale. Les chats directs fusionnent vers `agent:<agentId>:<mainKey>` (par défaut `main`), tandis que les chats de groupe/canal obtiennent leurs propres clés. `session.mainKey` est respecté.

Utilisez `session.dmScope` pour contrôler comment les **messages directs** sont groupés :

- `main` (par défaut) : tous les DM partagent la session principale pour la continuité.
- `per-peer` : isoler par id d'expéditeur à travers les canaux.
- `per-channel-peer` : isoler par canal + expéditeur (recommandé pour les boîtes de réception multi-utilisateurs).
- `per-account-channel-peer` : isoler par compte + canal + expéditeur (recommandé pour les boîtes de réception multi-comptes).
  Utilisez `session.identityLinks` pour mapper les ids de pairs préfixés par fournisseur vers une identité canonique afin que la même personne partage une session DM à travers les canaux lors de l'utilisation de `per-peer`, `per-channel-peer` ou `per-account-channel-peer`.

## Mode DM sécurisé (recommandé pour les configurations multi-utilisateurs)

> **Avertissement de sécurité :** Si votre agent peut recevoir des DM de **plusieurs personnes**, vous devriez fortement envisager d'activer le mode DM sécurisé. Sans cela, tous les utilisateurs partagent le même contexte de conversation, ce qui peut faire fuiter des informations privées entre utilisateurs.

**Exemple du problème avec les paramètres par défaut :**

- Alice (`<SENDER_A>`) envoie un message à votre agent sur un sujet privé (par exemple, un rendez-vous médical)
- Bob (`<SENDER_B>`) envoie un message à votre agent en demandant "De quoi parlions-nous ?"
- Parce que les deux DM partagent la même session, le modèle peut répondre à Bob en utilisant le contexte précédent d'Alice.

**La solution :** Définissez `dmScope` pour isoler les sessions par utilisateur :

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // Mode DM sécurisé : isoler le contexte DM par canal + expéditeur.
    dmScope: "per-channel-peer",
  },
}
```

**Quand activer ceci :**

- Vous avez des approbations d'appairage pour plus d'un expéditeur
- Vous utilisez une liste d'autorisation DM avec plusieurs entrées
- Vous définissez `dmPolicy: "open"`
- Plusieurs numéros de téléphone ou comptes peuvent envoyer des messages à votre agent

Notes :

- Par défaut, `dmScope: "main"` pour la continuité (tous les DM partagent la session principale). Ceci convient pour les configurations mono-utilisateur.
- Pour les boîtes de réception multi-comptes sur le même canal, préférez `per-account-channel-peer`.
- Si la même personne vous contacte sur plusieurs canaux, utilisez `session.identityLinks` pour fusionner leurs sessions DM en une identité canonique.
- Vous pouvez vérifier vos paramètres DM avec `openclaw security audit` (voir [sécurité](/fr-FR/cli/security)).

## La passerelle est la source de vérité

Tout l'état de session est **possédé par la passerelle** (l'"OpenClaw maître"). Les clients d'interface (app macOS, WebChat, etc.) doivent interroger la passerelle pour les listes de sessions et les comptages de jetons au lieu de lire les fichiers locaux.

- En **mode distant**, le magasin de sessions qui vous importe vit sur l'hôte de passerelle distant, pas sur votre Mac.
- Les comptages de jetons affichés dans les interfaces proviennent des champs du magasin de la passerelle (`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`). Les clients n'analysent pas les transcriptions JSONL pour "corriger" les totaux.

## Où vit l'état

- Sur l'**hôte de passerelle** :
  - Fichier de magasin : `~/.openclaw/agents/<agentId>/sessions/sessions.json` (par agent).
- Transcriptions : `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl` (les sessions de sujet Telegram utilisent `.../<SessionId>-topic-<threadId>.jsonl`).
- Le magasin est une carte `sessionKey -> { sessionId, updatedAt, ... }`. Supprimer des entrées est sûr ; elles sont recréées à la demande.
- Les entrées de groupe peuvent inclure `displayName`, `channel`, `subject`, `room` et `space` pour étiqueter les sessions dans les interfaces.
- Les entrées de session incluent des métadonnées `origin` (label + indices de routage) afin que les interfaces puissent expliquer d'où vient une session.
- OpenClaw ne lit **pas** les dossiers de session Pi/Tau hérités.

## Élagage de session

OpenClaw coupe les **anciens résultats d'outils** du contexte en mémoire juste avant les appels LLM par défaut.
Cela ne **réécrit pas** l'historique JSONL. Voir [/concepts/session-pruning](/fr-FR/concepts/session-pruning).

## Vidage mémoire pré-compaction

Quand une session approche de l'auto-compaction, OpenClaw peut exécuter un **tour silencieux de vidage mémoire**
qui rappelle au modèle d'écrire des notes durables sur disque. Ceci ne s'exécute que quand
l'espace de travail est accessible en écriture. Voir [Mémoire](/fr-FR/concepts/memory) et
[Compaction](/fr-FR/concepts/compaction).

## Mappage transports → clés de session

- Les chats directs suivent `session.dmScope` (par défaut `main`).
  - `main` : `agent:<agentId>:<mainKey>` (continuité à travers appareils/canaux).
    - Plusieurs numéros de téléphone et canaux peuvent mapper vers la même clé principale d'agent ; ils agissent comme transports dans une conversation.
  - `per-peer` : `agent:<agentId>:dm:<peerId>`.
  - `per-channel-peer` : `agent:<agentId>:<channel>:dm:<peerId>`.
  - `per-account-channel-peer` : `agent:<agentId>:<channel>:<accountId>:dm:<peerId>` (accountId par défaut `default`).
  - Si `session.identityLinks` correspond à un id de pair préfixé par fournisseur (par exemple `telegram:123`), la clé canonique remplace `<peerId>` afin que la même personne partage une session à travers les canaux.
- Les chats de groupe isolent l'état : `agent:<agentId>:<channel>:group:<id>` (les salons/canaux utilisent `agent:<agentId>:<channel>:channel:<id>`).
  - Les sujets de forum Telegram ajoutent `:topic:<threadId>` à l'id de groupe pour l'isolation.
  - Les clés `group:<id>` héritées sont toujours reconnues pour la migration.
- Les contextes entrants peuvent toujours utiliser `group:<id>` ; le canal est inféré à partir de `Provider` et normalisé vers la forme canonique `agent:<agentId>:<channel>:group:<id>`.
- Autres sources :
  - Tâches cron : `cron:<job.id>`
  - Webhooks : `hook:<uuid>` (sauf si explicitement défini par le hook)
  - Exécutions de nœud : `node-<nodeId>`

## Cycle de vie

- Politique de réinitialisation : les sessions sont réutilisées jusqu'à expiration, et l'expiration est évaluée au prochain message entrant.
- Réinitialisation quotidienne : par défaut à **4h00 heure locale sur l'hôte de passerelle**. Une session est obsolète une fois que sa dernière mise à jour est antérieure au temps de réinitialisation quotidien le plus récent.
- Réinitialisation d'inactivité (optionnel) : `idleMinutes` ajoute une fenêtre d'inactivité glissante. Quand les deux réinitialisations quotidienne et d'inactivité sont configurées, **celle qui expire en premier** force une nouvelle session.
- Inactivité héritée seule : si vous définissez `session.idleMinutes` sans aucune config `session.reset`/`resetByType`, OpenClaw reste en mode inactivité seule pour la rétrocompatibilité.
- Remplacements par type (optionnel) : `resetByType` vous permet de remplacer la politique pour les sessions `direct`, `group` et `thread` (thread = fils Slack/Discord, sujets Telegram, fils Matrix quand fournis par le connecteur).
- Remplacements par canal (optionnel) : `resetByChannel` remplace la politique de réinitialisation pour un canal (s'applique à tous les types de session pour ce canal et a la priorité sur `reset`/`resetByType`).
- Déclencheurs de réinitialisation : `/new` ou `/reset` exact (plus tout extra dans `resetTriggers`) démarre un nouvel id de session et passe le reste du message. `/new <model>` accepte un alias de modèle, `provider/model` ou nom de fournisseur (correspondance floue) pour définir le modèle de nouvelle session. Si `/new` ou `/reset` est envoyé seul, OpenClaw exécute un court tour de salutation "hello" pour confirmer la réinitialisation.
- Réinitialisation manuelle : supprimez des clés spécifiques du magasin ou retirez la transcription JSONL ; le prochain message les recrée.
- Les tâches cron isolées créent toujours un nouveau `sessionId` par exécution (pas de réutilisation d'inactivité).

## Politique d'envoi (optionnel)

Bloquez la livraison pour des types de session spécifiques sans lister les ids individuels.

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
        // Correspond à la clé de session brute (incluant le préfixe `agent:<id>:`).
        { action: "deny", match: { rawKeyPrefix: "agent:main:discord:" } },
      ],
      default: "allow",
    },
  },
}
```

Remplacement à l'exécution (propriétaire uniquement) :

- `/send on` → autoriser pour cette session
- `/send off` → refuser pour cette session
- `/send inherit` → effacer le remplacement et utiliser les règles de config
  Envoyez ceux-ci comme messages autonomes pour qu'ils s'enregistrent.

## Configuration (exemple de renommage optionnel)

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    scope: "per-sender", // garder les clés de groupe séparées
    dmScope: "main", // continuité DM (définir per-channel-peer/per-account-channel-peer pour les boîtes de réception partagées)
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      // Valeurs par défaut : mode=daily, atHour=4 (heure locale de l'hôte de passerelle).
      // Si vous définissez aussi idleMinutes, celui qui expire en premier gagne.
      mode: "daily",
      atHour: 4,
      idleMinutes: 120,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      direct: { mode: "idle", idleMinutes: 240 },
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

- `openclaw status` — affiche le chemin du magasin et les sessions récentes.
- `openclaw sessions --json` — vide chaque entrée (filtrer avec `--active <minutes>`).
- `openclaw gateway call sessions.list --params '{}'` — récupère les sessions depuis la passerelle en cours d'exécution (utilisez `--url`/`--token` pour l'accès à passerelle distante).
- Envoyez `/status` comme message autonome dans le chat pour voir si l'agent est joignable, combien du contexte de session est utilisé, les bascules thinking/verbose actuelles, et quand vos identifiants WhatsApp web ont été rafraîchis pour la dernière fois (aide à repérer les besoins de reconnexion).
- Envoyez `/context list` ou `/context detail` pour voir ce qui est dans l'invite système et les fichiers d'espace de travail injectés (et les plus gros contributeurs de contexte).
- Envoyez `/stop` comme message autonome pour abandonner l'exécution actuelle, vider les suivis en file d'attente pour cette session, et arrêter toutes les exécutions de sous-agents engendrées à partir de celle-ci (la réponse inclut le compte arrêté).
- Envoyez `/compact` (instructions optionnelles) comme message autonome pour résumer le contexte plus ancien et libérer de l'espace de fenêtre. Voir [/concepts/compaction](/fr-FR/concepts/compaction).
- Les transcriptions JSONL peuvent être ouvertes directement pour revoir les tours complets.

## Conseils

- Gardez la clé principale dédiée au trafic 1:1 ; laissez les groupes garder leurs propres clés.
- Lors de l'automatisation du nettoyage, supprimez des clés individuelles au lieu du magasin entier pour préserver le contexte ailleurs.

## Métadonnées d'origine de session

Chaque entrée de session enregistre d'où elle vient (meilleur effort) dans `origin` :

- `label` : label humain (résolu à partir du label de conversation + sujet/canal de groupe)
- `provider` : id de canal normalisé (incluant les extensions)
- `from`/`to` : ids de routage bruts de l'enveloppe entrante
- `accountId` : id de compte du fournisseur (quand multi-compte)
- `threadId` : id de fil/sujet quand le canal le supporte
  Les champs d'origine sont remplis pour les messages directs, canaux et groupes. Si un
  connecteur ne met à jour que le routage de livraison (par exemple, pour garder une session principale DM
  fraîche), il devrait toujours fournir le contexte entrant afin que la session garde ses
  métadonnées explicatives. Les extensions peuvent faire ceci en envoyant `ConversationLabel`,
  `GroupSubject`, `GroupChannel`, `GroupSpace` et `SenderName` dans le contexte
  entrant et en appelant `recordSessionMetaFromInbound` (ou en passant le même contexte
  à `updateLastRoute`).
