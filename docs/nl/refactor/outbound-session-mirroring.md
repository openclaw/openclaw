---
title: "Refactor van uitgaande sessiespiegeling (Issue #1520)" #1520)
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
---

# Refactor van uitgaande sessiespiegeling (Issue #1520)

## Status

- In uitvoering.
- Core- en plugin-kanaalroutering bijgewerkt voor uitgaande spiegeling.
- Gateway-send leidt nu de doelsessie af wanneer sessionKey wordt weggelaten.

## Context

Uitgaande verzendingen werden gespiegeld naar de _huidige_ agent-sessie (tool session key) in plaats van naar de doelsessiesleutel van het kanaal. Inkomende routering gebruikt kanaal-/peer-sessiesleutels, waardoor uitgaande reacties in de verkeerde sessie terechtkwamen en eerste-contactdoelen vaak geen sessie-items hadden.

## Doelen

- Uitgaande berichten spiegelen naar de doelsessiesleutel van het kanaal.
- Maak sessie invoergegevens aan op uitgaande wanneer deze ontbreken.
- Thread-/topic-scoping afgestemd houden op inkomende sessiesleutels.
- Core-kanalen plus gebundelde extensies dekken.

## Implementatiesamenvatting

- Nieuwe helper voor uitgaande sessieroutering:
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` bouwt de doelsessionKey met `buildAgentSessionKey` (dmScope + identityLinks).
  - `ensureOutboundSessionEntry` schrijft een minimale `MsgContext` via `recordSessionMetaFromInbound`.
- `runMessageAction` (send) leidt de doelsessionKey af en geeft deze door aan `executeSendAction` voor spiegeling.
- `message-tool` spiegelt niet langer direct; het lost alleen agentId op uit de huidige sessiesleutel.
- Het plugin-sendpad spiegelt via `appendAssistantMessageToSessionTranscript` met de afgeleide sessionKey.
- Gateway-send leidt een doelsessiesleutel af wanneer er geen is opgegeven (standaard agent) en zorgt voor een sessie-item.

## Thread-/topic-afhandeling

- Slack: replyTo/threadId -> `resolveThreadSessionKeys` (suffix).
- Discord: threadId/replyTo -> `resolveThreadSessionKeys` met `useSuffix=false` om inkomend te matchen (thread-kanaal-id bepaalt al de sessie).
- Telegram: topic-ID’s mappen naar `chatId:topic:<id>` via `buildTelegramGroupPeerId`.

## Gedekte extensies

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon.
- Notities:
  - Mattermost-doelen strippen nu `@` voor DM-sessiesleutelroutering.
  - Zalo Personal gebruikt DM peer kind voor 1:1-doelen (groep alleen wanneer `group:` aanwezig is).
  - BlueBubbles-groepsdoelen strippen `chat_*`-prefixen om inkomende sessiesleutels te matchen.
  - Slack auto-thread-spiegeling matcht kanaal-ID’s hoofdletterongevoelig.
  - Gateway-send zet aangeleverde sessiesleutels om naar lowercase vóór spiegeling.

## Besluiten

- **Gateway-send sessieafleiding**: als `sessionKey` is opgegeven, gebruik deze. Als deze ontbreekt, leid een sessionKey af van doel + standaard agent en spiegel daarheen.
- **Aanmaken van sessies**: gebruik altijd `recordSessionMetaFromInbound` met `Provider/From/To/ChatType/AccountId/Originating*` afgestemd op inkomende formaten.
- **Doelnormalisatie**: uitgaande routering gebruikt opgeloste doelen (na `resolveChannelTarget`) wanneer beschikbaar.
- **Hoofdlettergebruik van sessiesleutels**: canoniseer sessiesleutels naar lowercase bij schrijven en tijdens migraties.

## Toegevoegde/bijgewerkte tests

- `src/infra/outbound/outbound-session.test.ts`
  - Slack-thread-sessiesleutel.
  - Telegram-topic-sessiesleutel.
  - dmScope identityLinks met Discord.
- `src/agents/tools/message-tool.test.ts`
  - Leidt agentId af uit sessiesleutel (geen sessionKey doorgegeven).
- `src/gateway/server-methods/send.test.ts`
  - Leidt sessiesleutel af wanneer weggelaten en maakt een sessie-item aan.

## Open punten / vervolgstappen

- De voice-call-plugin gebruikt aangepaste `voice:<phone>`-sessiesleutels. Uitgaande mapping is hier niet gestandaardiseerd; als message-tool voice-call-verzendingen moet ondersteunen, voeg expliciete mapping toe.
- Bevestigen of een externe plugin niet-standaard `From/To`-formaten gebruikt buiten de gebundelde set.

## Aangeraakte bestanden

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- Tests in:
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
