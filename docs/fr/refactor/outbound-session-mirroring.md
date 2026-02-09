---
title: Refactorisation du mirroring de session sortante (Issue #1520) #1520)
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
---

# Refactorisation du mirroring de session sortante (Issue #1520)

## Statut

- En cours.
- Le routage des canaux core + plugins est mis à jour pour le mirroring sortant.
- L’envoi via la Gateway (passerelle) derive désormais la session cible lorsque sessionKey est omis.

## Contexte

Les envois sortants étaient dupliqués dans la session agent _courante_ (clé de session de l’outil) plutôt que dans la session du canal cible. Le routage entrant utilise des clés de session canal/peer ; ainsi, les réponses sortantes atterrissaient dans la mauvaise session et les cibles de premier contact n’avaient souvent pas d’entrées de session.

## Objectifs

- Dupliquer les messages sortants dans la clé de session du canal cible.
- Créer des entrées de session lors des envois sortants lorsqu’elles sont manquantes.
- Maintenir l’alignement du périmètre thread/sujet avec les clés de session entrantes.
- Couvrir les canaux core ainsi que les extensions fournies.

## Resume de l’implementation

- Nouvel utilitaire de routage de session sortante :
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` construit la sessionKey cible à l’aide de `buildAgentSessionKey` (dmScope + identityLinks).
  - `ensureOutboundSessionEntry` écrit un `MsgContext` minimal via `recordSessionMetaFromInbound`.
- `runMessageAction` (send) derive la sessionKey cible et la transmet à `executeSendAction` pour le mirroring.
- `message-tool` ne duplique plus directement ; il se contente de resoudre l’agentId à partir de la clé de session courante.
- Le chemin d’envoi des plugins duplique via `appendAssistantMessageToSessionTranscript` en utilisant la sessionKey derivee.
- L’envoi via la Gateway (passerelle) derive une clé de session cible lorsqu’aucune n’est fournie (agent par defaut) et garantit une entrée de session.

## Gestion des threads/sujets

- Slack : replyTo/threadId -> `resolveThreadSessionKeys` (suffixe).
- Discord : threadId/replyTo -> `resolveThreadSessionKeys` avec `useSuffix=false` pour correspondre à l’entrant (l’identifiant du canal de thread délimite déjà la session).
- Telegram : les identifiants de sujet correspondent à `chatId:topic:<id>` via `buildTelegramGroupPeerId`.

## Extensions couvertes

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon.
- Notes :
  - Les cibles Mattermost suppriment désormais `@` pour le routage de clé de session DM.
  - Zalo Personal utilise le type de peer DM pour les cibles 1:1 (groupe uniquement lorsque `group:` est present).
  - Les cibles de groupe BlueBubbles suppriment les prefixes `chat_*` pour correspondre aux clés de session entrantes.
  - Le mirroring auto-thread Slack correspond aux identifiants de canal sans tenir compte de la casse.
  - L’envoi via la Gateway (passerelle) met en minuscules les clés de session fournies avant le mirroring.

## Decisions

- **Derivation de session pour l’envoi via la Gateway (passerelle)** : si `sessionKey` est fourni, l’utiliser. S’il est omis, deriver une sessionKey à partir de la cible + de l’agent par defaut et dupliquer à cet endroit.
- **Creation d’entrée de session** : toujours utiliser `recordSessionMetaFromInbound` avec `Provider/From/To/ChatType/AccountId/Originating*` aligné sur les formats entrants.
- **Normalisation des cibles** : le routage sortant utilise des cibles resolues (post `resolveChannelTarget`) lorsqu’elles sont disponibles.
- **Casse des clés de session** : canoniser les clés de session en minuscules lors de l’écriture et pendant les migrations.

## Tests ajoutes/mis a jour

- `src/infra/outbound/outbound-session.test.ts`
  - Clé de session de thread Slack.
  - Clé de session de sujet Telegram.
  - identityLinks dmScope avec Discord.
- `src/agents/tools/message-tool.test.ts`
  - Derive l’agentId à partir de la clé de session (aucune sessionKey transmise).
- `src/gateway/server-methods/send.test.ts`
  - Derive la clé de session lorsqu’elle est omise et crée une entrée de session.

## Elements ouverts / Suivis

- Le plugin d’appel vocal utilise des clés de session `voice:<phone>` personnalisées. Le mapping sortant n’est pas standardisé ici ; si l’outil de messagerie doit prendre en charge les envois d’appels vocaux, ajouter un mapping explicite.
- Confirmer si un plugin externe utilise des formats `From/To` non standard au-delà de l’ensemble fourni.

## Fichiers modifies

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- Tests dans :
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
