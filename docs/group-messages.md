# Group Messages Plan

Goal: Enable warelay’s web provider to participate in WhatsApp group chats, replying only when mentioned and using recent group context. Keep personal (1:1) sessions separate from group sessions.

## Scope & Constraints
- Web provider only; Twilio untouched.
- Default-safe: no unsolicited group replies unless mentioned.
- Preserve existing direct-chat behavior and batching.

## Design Decisions
- **Config**: Add `inbound.groupChat` with:
  - `requireMention` (default: `true`)
  - `mentionPatterns` (array of regex strings; optional)
  - `historyLimit` (default: 50)
- **Conversation identity**:
  - Direct chats keyed by E.164 (`+123`).
  - Group chats keyed by raw group JID (`<id>@g.us`) and labeled `chatType: "group"`.
- **Mention detection**:
  - Trust Baileys `contextInfo.mentionedJid` vs our own self JID.
  - Fallback regex match on body using `mentionPatterns`.
- **Group context**:
  - Maintain per-group ring buffer of messages since last bot reply (cap `historyLimit`).
  - When mentioned, prepend `[Chat messages since your last reply]` section with `sender: body`, then current message.
  - Clear buffer after replying.
- **Gating**:
  - If `requireMention` and no mention detected, store in buffer only; no reply.
  - Allow opt-out via `requireMention: false`.
- **Allow list**:
  - Apply `inbound.allowFrom` to the *participant* (senderE164), not the group ID. Same-phone bypass preserved.
- **Heartbeats**:
  - Skip reply heartbeats when the last inbound was a group chat; connection heartbeat still runs.
- **Sessions**:
  - Session key uses group conversation id so group threads don’t collide with personal sessions.

## Implementation Steps
1) Config/schema/docs
   - Extend `WarelayConfig` + Zod schema with `inbound.groupChat`.
   - Add defaults and README config table entry.
2) Inbound plumbing (`src/web/inbound.ts`)
   - Detect groups, surface `chatId`, `chatType`, `senderJid`, `senderE164`, `senderName`, and `mentionedJids`.
   - Apply `allowFrom` to participant; keep mark-read with participant.
3) Auto-reply loop (`src/web/auto-reply.ts`)
   - Key batching/history by conversation id (group vs direct).
   - Implement mention gating and context injection from history.
   - Clear history after reply; cap history length.
   - Guard heartbeats for groups.
   - Ensure session key uses conversation id for groups.
4) Tests
   - Inbound: group passthrough + allowFrom on participant + mention capture.
   - Auto-reply: mention gating, history accumulation/clear, batching by group, session separation, heartbeat skip for groups.

## Open Questions / TODO
- Should we expose a configurable bot self-name for pattern defaults (e.g., auto-generate `mentionPatterns` from selfJid/local number)? For now, rely on explicit config + WhatsApp mentions.
- Do we need a max age for stored history (time-based) in addition to count-based cap? Default to count-only unless it becomes noisy.
