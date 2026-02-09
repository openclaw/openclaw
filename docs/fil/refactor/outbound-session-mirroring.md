---
title: "Refactor ng Outbound Session Mirroring (Isyu #1520)" #1520)
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
---

# Refactor ng Outbound Session Mirroring (Isyu #1520)

## Status

- Isinasagawa.
- Na-update ang core + plugin channel routing para sa outbound mirroring.
- Ang Gateway send ay ngayon ay nagde-derive ng target session kapag ang sessionKey ay hindi ibinigay.

## Konteksto

32. Ang mga outbound send ay na-mirror sa _kasalukuyang_ agent session (tool session key) sa halip na sa target channel session. 33. Ang inbound routing ay gumagamit ng channel/peer session keys, kaya ang mga outbound response ay napunta sa maling session at ang mga first-contact target ay madalas na walang mga session entry.

## Mga Layunin

- I-mirror ang mga outbound na mensahe sa target channel session key.
- Lumikha ng mga entry ng session sa outbound kapag wala.
- Panatilihing naka-align ang thread/topic scoping sa mga inbound session key.
- Saklawin ang mga core channel pati ang mga bundled extension.

## Buod ng Implementasyon

- Bagong outbound session routing helper:
  - `src/infra/outbound/outbound-session.ts`
  - Ang `resolveOutboundSessionRoute` ay bumubuo ng target sessionKey gamit ang `buildAgentSessionKey` (dmScope + identityLinks).
  - Ang `ensureOutboundSessionEntry` ay nagsusulat ng minimal na `MsgContext` sa pamamagitan ng `recordSessionMetaFromInbound`.
- Ang `runMessageAction` (send) ay nagde-derive ng target sessionKey at ipinapasa ito sa `executeSendAction` para sa mirroring.
- Ang `message-tool` ay hindi na direktang nagmi-mirror; nire-resolve na lamang nito ang agentId mula sa kasalukuyang session key.
- Ang plugin send path ay nagmi-mirror sa pamamagitan ng `appendAssistantMessageToSessionTranscript` gamit ang derived sessionKey.
- Ang Gateway send ay nagde-derive ng target session key kapag wala itong ibinigay (default agent), at tinitiyak na may entry ng session.

## Thread/Topic Handling

- Slack: replyTo/threadId -> `resolveThreadSessionKeys` (suffix).
- Discord: threadId/replyTo -> `resolveThreadSessionKeys` na may `useSuffix=false` para tumugma sa inbound (ang thread channel id ay nag-i-scope na ng session).
- Telegram: ang mga topic ID ay mina-map sa `chatId:topic:<id>` sa pamamagitan ng `buildTelegramGroupPeerId`.

## Mga Extension na Saklaw

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon.
- Mga tala:
  - Ang mga target ng Mattermost ay ngayon ay nagtatanggal ng `@` para sa DM session key routing.
  - Ang Zalo Personal ay gumagamit ng DM peer kind para sa mga 1:1 na target (group lamang kapag may `group:`).
  - Ang mga group target ng BlueBubbles ay nagtatanggal ng mga `chat_*` prefix upang tumugma sa mga inbound session key.
  - Ang Slack auto-thread mirroring ay tumutugma sa mga channel id nang hindi case-sensitive.
  - Ang Gateway send ay naglo-lowercase ng mga ibinigay na session key bago mag-mirror.

## Mga Desisyon

- 34. **Gateway send session derivation**: kung ibinigay ang `sessionKey`, gamitin ito. 35. Kung hindi isinama, mag-derive ng isang sessionKey mula sa target + default agent at doon i-mirror.
- **Paglikha ng entry ng session**: palaging gamitin ang `recordSessionMetaFromInbound` na may `Provider/From/To/ChatType/AccountId/Originating*` na naka-align sa mga inbound format.
- **Target normalization**: ang outbound routing ay gumagamit ng mga resolved target (post `resolveChannelTarget`) kapag available.
- **Casing ng session key**: i-canonicalize ang mga session key sa lowercase sa pagsulat at sa panahon ng mga migration.

## Mga Test na Idinagdag/In-update

- `src/infra/outbound/outbound-session.test.ts`
  - Slack thread session key.
  - Telegram topic session key.
  - dmScope identityLinks sa Discord.
- `src/agents/tools/message-tool.test.ts`
  - Nagde-derive ng agentId mula sa session key (walang sessionKey na ipinapasa).
- `src/gateway/server-methods/send.test.ts`
  - Nagde-derive ng session key kapag hindi ibinigay at lumilikha ng entry ng session.

## Mga Open Item / Follow-up

- 36. Ang voice-call plugin ay gumagamit ng custom na `voice:<phone>` session keys. 37. Ang outbound mapping ay hindi standardized dito; kung ang message-tool ay dapat sumuporta sa voice-call sends, magdagdag ng explicit na mapping.
- Kumpirmahin kung may external plugin na gumagamit ng non-standard na `From/To` na mga format lampas sa bundled set.

## Mga File na Na-touch

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- Mga test sa:
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
