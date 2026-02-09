---
title: "Omstrukturering av spegling av utgående sessioner (Issue #1520)" #1520)
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
---

# Omstrukturering av spegling av utgående sessioner (Issue #1520)

## Status

- Pågår.
- Kärn- och plugin-kanalrouting uppdaterad för utgående spegling.
- Gateway-sändning härleder nu mål-session när sessionKey utelämnas.

## Kontext

Utgående sändningar speglades i _current_ -sessionen (verktygets sessionsnyckel) istället för målkanalens session. Inkommande routing använder kanal/peer sessionsnycklar, så utgående svar landade i fel session och första-kontakt mål ofta saknade sessionsposter.

## Mål

- Spegla utgående meddelanden till målkanalens sessionKey.
- Skapa sessionsposter vid utgående när de saknas.
- Hålla tråd-/ämnesavgränsning i linje med inkommande sessionnycklar.
- Täcka kärnkanaler samt medföljande tillägg.

## Sammanfattning av implementering

- Ny hjälpare för utgående sessionsrouting:
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` bygger mål-sessionKey med `buildAgentSessionKey` (dmScope + identityLinks).
  - `ensureOutboundSessionEntry` skriver minimal `MsgContext` via `recordSessionMetaFromInbound`.
- `runMessageAction` (send) härleder mål-sessionKey och skickar den till `executeSendAction` för spegling.
- `message-tool` speglar inte längre direkt; den löser endast agentId från den aktuella sessionnyckeln.
- Plugin-sändningsvägen speglar via `appendAssistantMessageToSessionTranscript` med den härledda sessionKey.
- Gateway-sändning härleder en mål-sessionnyckel när ingen tillhandahålls (standardagent) och säkerställer en sessionspost.

## Tråd-/ämneshantering

- Slack: replyTo/threadId -> `resolveThreadSessionKeys` (suffix).
- Discord: threadId/replyTo -> `resolveThreadSessionKeys` med `useSuffix=false` för att matcha inkommande (trådkanal-id avgränsar redan session).
- Telegram: ämnes-id:n mappar till `chatId:topic:<id>` via `buildTelegramGroupPeerId`.

## Tillägg som täcks

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon.
- Noteringar:
  - Mattermost-mål tar nu bort `@` för DM-sessionnyckelrouting.
  - Zalo Personal använder DM-peer-typ för 1:1-mål (grupp endast när `group:` finns).
  - BlueBubbles-gruppmål tar bort `chat_*`‑prefix för att matcha inkommande sessionnycklar.
  - Slack automatisk trådspegling matchar kanal-id:n skiftlägesokänsligt.
  - Gateway-sändning gör tillhandahållna sessionnycklar till gemener före spegling.

## Beslut

- **Gateway skicka sessionshärledning**: om `sessionKey` tillhandahålls, använd den. Om utelämnas, härleda en sessionKey från mål + standardagent och spegla där.
- **Skapande av sessionspost**: använd alltid `recordSessionMetaFromInbound` med `Provider/From/To/ChatType/AccountId/Originating*` i linje med inkommande format.
- **Målnormalisering**: utgående routing använder lösta mål (efter `resolveChannelTarget`) när de finns tillgängliga.
- **Versalisering av sessionnycklar**: kanonisera sessionnycklar till gemener vid skrivning och under migreringar.

## Tester tillagda/uppdaterade

- `src/infra/outbound/outbound-session.test.ts`
  - Slack tråd-sessionnyckel.
  - Telegram ämnes-sessionnyckel.
  - dmScope identityLinks med Discord.
- `src/agents/tools/message-tool.test.ts`
  - Härleder agentId från sessionnyckel (ingen sessionKey skickas igenom).
- `src/gateway/server-methods/send.test.ts`
  - Härleder sessionnyckel när den utelämnas och skapar sessionspost.

## Öppna punkter / uppföljningar

- Voice-call plugin använder anpassade `voice:<phone>` sessionsnycklar. Utgående kartläggning är inte standardiserad här; om meddelande-verktyg bör stödja röstsamtal skickar, lägg till explicit kartläggning.
- Bekräfta om någon extern plugin använder icke‑standardiserade `From/To`-format utöver den medföljande uppsättningen.

## Filer som berörts

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- Tester i:
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
