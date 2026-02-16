---
title: "Refactor Mirroring Session Outbound (Issue #1520)"
description: "Tracker notes refactor mirroring session outbound, décisions, tests et items ouverts."
---

# Refactor Mirroring Session Outbound (Issue #1520)

## Statut

- En cours.
- Routing channel core + plugin mis à jour pour mirroring outbound.
- Send passerelle dérive maintenant session cible quand sessionKey omise.

## Contexte

Envois outbound mirrorés dans session agent _actuelle_ (clé session tool) plutôt que session channel cible. Routing inbound utilise clés session channel/peer, donc réponses outbound atterrissaient dans mauvaise session et cibles first-contact manquaient souvent entrées session.

## Objectifs

- Mirrorer messages outbound dans clé session channel cible.
- Créer entrées session sur outbound quand manquantes.
- Garder scoping thread/topic aligné avec clés session inbound.
- Couvrir channels core plus extensions bundled.

## Résumé implémentation

- Nouveau helper routing session outbound :
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` construit sessionKey cible utilisant `buildAgentSessionKey` (dmScope + identityLinks).
  - `ensureOutboundSessionEntry` écrit `MsgContext` minimal via `recordSessionMetaFromInbound`.
- `runMessageAction` (send) dérive sessionKey cible et passe à `executeSendAction` pour mirroring.
- `message-tool` ne mirror plus directement ; résout seulement agentId depuis clé session actuelle.
- Chemin send plugin mirror via `appendAssistantMessageToSessionTranscript` utilisant sessionKey dérivée.
- Send passerelle dérive clé session cible quand aucune fournie (agent défaut), et assure entrée session.

## Gestion Thread/Topic

- Slack : replyTo/threadId → `resolveThreadSessionKeys` (suffix).
- Discord : threadId/replyTo → `resolveThreadSessionKeys` avec `useSuffix=false` pour matcher inbound (thread channel id scope déjà session).
- Telegram : IDs topic mappent vers `chatId:topic:<id>` via `buildTelegramGroupPeerId`.

## Extensions Couvertes

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon.
- Notes :
  - Cibles Mattermost strip maintenant `@` pour routing clé session DM.
  - Zalo Personal utilise kind peer DM pour cibles 1:1 (groupe seulement quand `group:` présent).
  - Cibles groupe BlueBubbles strippent préfixes `chat_*` pour matcher clés session inbound.
  - Auto-thread mirroring Slack matche IDs channel case-insensitively.
  - Send passerelle lowercases clés session fournies avant mirroring.

## Décisions

- **Dérivation session send passerelle** : si `sessionKey` fournie, utilisez-la. Si omise, dérivez sessionKey depuis cible + agent défaut et mirrorez là.
- **Création entrée session** : toujours utiliser `recordSessionMetaFromInbound` avec `Provider/From/To/ChatType/AccountId/Originating*` alignés vers formats inbound.
- **Normalisation cible** : routing outbound utilise cibles résolues (post `resolveChannelTarget`) quand disponibles.
- **Casing clé session** : canonicaliser clés session vers lowercase lors écriture et durant migrations.

## Tests Ajoutés/Mis à jour

- `src/infra/outbound/outbound-session.test.ts`
  - Clé session thread Slack.
  - Clé session topic Telegram.
  - dmScope identityLinks avec Discord.
- `src/agents/tools/message-tool.test.ts`
  - Dérive agentId depuis clé session (aucune sessionKey passée through).
- `src/gateway/server-methods/send.test.ts`
  - Dérive clé session quand omise et crée entrée session.

## Items ouverts / Follow-ups

- Plugin voice-call utilise clés session custom `voice:<phone>`. Mapping outbound non standardisé ici ; si message-tool doit supporter sends voice-call, ajoutez mapping explicite.
- Confirmer si plugin externe utilise formats `From/To` non-standards au-delà ensemble bundled.

Voir aussi :

- [Routing Channel](/fr-FR/channels/channel-routing)
- [Configuration](/fr-FR/gateway/configuration)
- [Sessions](/fr-FR/reference/session-management-compaction)
