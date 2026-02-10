---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: Outbound Session Mirroring Refactor (Issue #1520)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Outbound Session Mirroring Refactor (Issue #1520)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- In progress.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Core + plugin channel routing updated for outbound mirroring.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway send now derives target session when sessionKey is omitted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Outbound sends were mirrored into the _current_ agent session (tool session key) rather than the target channel session. Inbound routing uses channel/peer session keys, so outbound responses landed in the wrong session and first-contact targets often lacked session entries.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Goals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mirror outbound messages into the target channel session key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Create session entries on outbound when missing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep thread/topic scoping aligned with inbound session keys.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cover core channels plus bundled extensions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Implementation Summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- New outbound session routing helper:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `src/infra/outbound/outbound-session.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `resolveOutboundSessionRoute` builds target sessionKey using `buildAgentSessionKey` (dmScope + identityLinks).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `ensureOutboundSessionEntry` writes minimal `MsgContext` via `recordSessionMetaFromInbound`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `runMessageAction` (send) derives target sessionKey and passes it to `executeSendAction` for mirroring.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message-tool` no longer mirrors directly; it only resolves agentId from the current session key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugin send path mirrors via `appendAssistantMessageToSessionTranscript` using the derived sessionKey.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway send derives a target session key when none is provided (default agent), and ensures a session entry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Thread/Topic Handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack: replyTo/threadId -> `resolveThreadSessionKeys` (suffix).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: threadId/replyTo -> `resolveThreadSessionKeys` with `useSuffix=false` to match inbound (thread channel id already scopes session).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: topic IDs map to `chatId:topic:<id>` via `buildTelegramGroupPeerId`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Extensions Covered（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Mattermost targets now strip `@` for DM session key routing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Zalo Personal uses DM peer kind for 1:1 targets (group only when `group:` is present).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - BlueBubbles group targets strip `chat_*` prefixes to match inbound session keys.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Slack auto-thread mirroring matches channel ids case-insensitively.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Gateway send lowercases provided session keys before mirroring.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Decisions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Gateway send session derivation**: if `sessionKey` is provided, use it. If omitted, derive a sessionKey from target + default agent and mirror there.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Session entry creation**: always use `recordSessionMetaFromInbound` with `Provider/From/To/ChatType/AccountId/Originating*` aligned to inbound formats.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Target normalization**: outbound routing uses resolved targets (post `resolveChannelTarget`) when available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Session key casing**: canonicalize session keys to lowercase on write and during migrations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tests Added/Updated（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/infra/outbound/outbound-session.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Slack thread session key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Telegram topic session key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - dmScope identityLinks with Discord.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/tools/message-tool.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Derives agentId from session key (no sessionKey passed through).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/gateway/server-methods/send.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Derives session key when omitted and creates session entry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Open Items / Follow-ups（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Voice-call plugin uses custom `voice:<phone>` session keys. Outbound mapping is not standardized here; if message-tool should support voice-call sends, add explicit mapping.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Confirm if any external plugin uses non-standard `From/To` formats beyond the bundled set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Files Touched（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/infra/outbound/outbound-session.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/infra/outbound/outbound-send-service.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/infra/outbound/message-action-runner.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/tools/message-tool.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/gateway/server-methods/send.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tests in:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `src/infra/outbound/outbound-session.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `src/agents/tools/message-tool.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `src/gateway/server-methods/send.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
