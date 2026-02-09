---
title: "Refaktorering af udgående sessionsspejling (Issue #1520)" #1520)
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
---

# Refaktorering af udgående sessionsspejling (Issue #1520)

## Status

- I gang.
- Core + plugin-kanalrouting opdateret til udgående spejling.
- Gateway-send udleder nu mål-session, når sessionKey udelades.

## Kontekst

Udgående udsendelser blev spejlet ind i _current_ agent sessionen (værktøjs sessionsnøgle) i stedet for målkanalsessionen. Indgående routing bruger kanal/peer session nøgler, så udgående svar landede i den forkerte session og første kontakt mål ofte manglede session indgange.

## Mål

- Spejl udgående beskeder ind i målkanalens sessionsnøgle.
- Opret sessionsposter ved udgående afsendelser, når de mangler.
- Hold tråd-/emne-afgrænsning på linje med indgående sessionsnøgler.
- Dæk kernekanaler samt medfølgende udvidelser.

## Implementeringsoversigt

- Ny hjælper til udgående sessionsrouting:
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` bygger mål-sessionKey ved hjælp af `buildAgentSessionKey` (dmScope + identityLinks).
  - `ensureOutboundSessionEntry` skriver minimal `MsgContext` via `recordSessionMetaFromInbound`.
- `runMessageAction` (send) udleder mål-sessionKey og sender den til `executeSendAction` for spejling.
- `message-tool` spejler ikke længere direkte; den resolver kun agentId fra den aktuelle sessionsnøgle.
- Plugin-sendesti spejler via `appendAssistantMessageToSessionTranscript` ved brug af den udledte sessionKey.
- Gateway-send udleder en mål-sessionsnøgle, når ingen er angivet (standardagent), og sikrer en sessionspost.

## Tråd-/emnehåndtering

- Slack: replyTo/threadId -> `resolveThreadSessionKeys` (suffix).
- Discord: threadId/replyTo -> `resolveThreadSessionKeys` med `useSuffix=false` for at matche indgående (trådkanal-id afgrænser allerede sessionen).
- Telegram: emne-id’er mapper til `chatId:topic:<id>` via `buildTelegramGroupPeerId`.

## Dækkede udvidelser

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon.
- Noter:
  - Mattermost-mål fjerner nu `@` for DM-sessionsnøglerouting.
  - Zalo Personal bruger DM-peer-type til 1:1-mål (gruppe kun når `group:` er til stede).
  - BlueBubbles-gruppemål fjerner `chat_*`-præfikser for at matche indgående sessionsnøgler.
  - Slack auto-tråd-spejling matcher kanal-id’er uden hensyn til store/små bogstaver.
  - Gateway-send laver provided sessionsnøgler om til små bogstaver før spejling.

## Beslutninger

- **Gateway send session afledning**: hvis `sessionKey` er leveret, brug den. Hvis udeladt, udlede en sessionKey fra mål + standard agent og spejl der.
- **Oprettelse af sessionsposter**: brug altid `recordSessionMetaFromInbound` med `Provider/From/To/ChatType/AccountId/Originating*` justeret til indgående formater.
- **Målnormalisering**: udgående routing bruger resolverede mål (post `resolveChannelTarget`), når de er tilgængelige.
- **Bogstavstørrelse i sessionsnøgler**: kanoniser sessionsnøgler til små bogstaver ved skrivning og under migreringer.

## Tilføjede/opdaterede tests

- `src/infra/outbound/outbound-session.test.ts`
  - Slack-tråd sessionsnøgle.
  - Telegram-emne sessionsnøgle.
  - dmScope identityLinks med Discord.
- `src/agents/tools/message-tool.test.ts`
  - Udleder agentId fra sessionsnøgle (ingen sessionKey videresendes).
- `src/gateway/server-methods/send.test.ts`
  - Udleder sessionsnøgle, når den udelades, og opretter sessionspost.

## Åbne punkter / Opfølgninger

- Plugin til stemmeopkald bruger brugerdefinerede `voice:<phone>` session nøgler. Outbound mapping er ikke standardiseret her; hvis message-tool skulle understøtte voice-call sends, tilføj eksplicit mapping.
- Bekræft om eksterne plugins bruger ikke-standard `From/To`-formater ud over det medfølgende sæt.

## Berørte filer

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- Tests i:
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
