---
title: Outbound Session Mirroring Refactor (Issue #1520)
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
---

# Outbound Session Mirroring Refactor (Issue #1520)

## Status
- In progress.
- Core + plugin channel routing updated for outbound mirroring.
- Gateway send now derives target session when sessionKey is omitted.

## Context
Outbound sends were mirrored into the *current* agent session (tool session key) rather than the target channel session. Inbound routing uses channel/peer session keys, so outbound responses landed in the wrong session and first-contact targets often lacked session entries.

## Goals
- Mirror outbound messages into the target channel session key.
- Create session entries on outbound when missing.
- Keep thread/topic scoping aligned with inbound session keys.
- Cover core channels plus bundled extensions.

## Implementation Summary
- New outbound session routing helper:
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` builds target sessionKey using `buildAgentSessionKey` (dmScope + identityLinks).
  - `ensureOutboundSessionEntry` writes minimal `MsgContext` via `recordSessionMetaFromInbound`.
- `runMessageAction` (send) derives target sessionKey and passes it to `executeSendAction` for mirroring.
- `message-tool` no longer mirrors directly; it only resolves agentId from the current session key.
- Plugin send path mirrors via `appendAssistantMessageToSessionTranscript` using the derived sessionKey.
- Gateway send derives a target session key when none is provided (default agent), and ensures a session entry.

## Thread/Topic Handling
- Slack: replyTo/threadId -> `resolveThreadSessionKeys` (suffix).
- Discord: threadId/replyTo -> `resolveThreadSessionKeys` with `useSuffix=false` to match inbound (thread channel id already scopes session).
- Telegram: topic IDs map to `chatId:topic:<id>` via `buildTelegramGroupPeerId`.

## Extensions Covered
- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon.
- Notes:
  - Mattermost targets now strip `@` for DM session key routing.
  - Zalo Personal uses DM peer kind for 1:1 targets (group only when `group:` is present).
  - BlueBubbles group targets strip `chat_*` prefixes to match inbound session keys.
  - Slack auto-thread mirroring matches channel ids case-insensitively.
  - Gateway send lowercases provided session keys before mirroring.

## Decisions
- **Gateway send session derivation**: if `sessionKey` is provided, use it. If omitted, derive a sessionKey from target + default agent and mirror there.
- **Session entry creation**: always use `recordSessionMetaFromInbound` with `Provider/From/To/ChatType/AccountId/Originating*` aligned to inbound formats.
- **Target normalization**: outbound routing uses resolved targets (post `resolveChannelTarget`) when available.
- **Session key casing**: canonicalize session keys to lowercase on write and during migrations.

## Tests Added/Updated
- `src/infra/outbound/outbound-session.test.ts`
  - Slack thread session key.
  - Telegram topic session key.
  - dmScope identityLinks with Discord.
- `src/agents/tools/message-tool.test.ts`
  - Derives agentId from session key (no sessionKey passed through).
- `src/gateway/server-methods/send.test.ts`
  - Derives session key when omitted and creates session entry.

## Open Items / Follow-ups
- Voice-call plugin uses custom `voice:<phone>` session keys. Outbound mapping is not standardized here; if message-tool should support voice-call sends, add explicit mapping.
- Confirm if any external plugin uses non-standard `From/To` formats beyond the bundled set.

## Files Touched
- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- Tests in:
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
