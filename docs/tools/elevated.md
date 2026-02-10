---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Elevated exec mode and /elevated directives"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adjusting elevated mode defaults, allowlists, or slash command behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Elevated Mode"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Elevated Mode (/elevated directives)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What it does（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/elevated on` runs on the gateway host and keeps exec approvals (same as `/elevated ask`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/elevated full` runs on the gateway host **and** auto-approves exec (skips exec approvals).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/elevated ask` runs on the gateway host but keeps exec approvals (same as `/elevated on`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `on`/`ask` do **not** force `exec.security=full`; configured security/ask policy still applies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Only changes behavior when the agent is **sandboxed** (otherwise exec already runs on the host).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Directive forms: `/elevated on|off|ask|full`, `/elev on|off|ask|full`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Only `on|off|ask|full` are accepted; anything else returns a hint and does not change state.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What it controls (and what it doesn’t)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Availability gates**: `tools.elevated` is the global baseline. `agents.list[].tools.elevated` can further restrict elevated per agent (both must allow).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Per-session state**: `/elevated on|off|ask|full` sets the elevated level for the current session key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Inline directive**: `/elevated on|ask|full` inside a message applies to that message only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Groups**: In group chats, elevated directives are only honored when the agent is mentioned. Command-only messages that bypass mention requirements are treated as mentioned.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Host execution**: elevated forces `exec` onto the gateway host; `full` also sets `security=full`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Approvals**: `full` skips exec approvals; `on`/`ask` honor them when allowlist/ask rules require.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Unsandboxed agents**: no-op for location; only affects gating, logging, and status.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Tool policy still applies**: if `exec` is denied by tool policy, elevated cannot be used.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Separate from `/exec`**: `/exec` adjusts per-session defaults for authorized senders and does not require elevated.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Resolution order（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Inline directive on the message (applies only to that message).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Session override (set by sending a directive-only message).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Global default (`agents.defaults.elevatedDefault` in config).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Setting a session default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Send a message that is **only** the directive (whitespace allowed), e.g. `/elevated full`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Confirmation reply is sent (`Elevated mode set to full...` / `Elevated mode disabled.`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If elevated access is disabled or the sender is not on the approved allowlist, the directive replies with an actionable error and does not change session state.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Send `/elevated` (or `/elevated:`) with no argument to see the current elevated level.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Availability + allowlists（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Feature gate: `tools.elevated.enabled` (default can be off via config even if the code supports it).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sender allowlist: `tools.elevated.allowFrom` with per-provider allowlists (e.g. `discord`, `whatsapp`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Per-agent gate: `agents.list[].tools.elevated.enabled` (optional; can only further restrict).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Per-agent allowlist: `agents.list[].tools.elevated.allowFrom` (optional; when set, the sender must match **both** global + per-agent allowlists).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord fallback: if `tools.elevated.allowFrom.discord` is omitted, the `channels.discord.dm.allowFrom` list is used as a fallback. Set `tools.elevated.allowFrom.discord` (even `[]`) to override. Per-agent allowlists do **not** use the fallback.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- All gates must pass; otherwise elevated is treated as unavailable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Logging + status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Elevated exec calls are logged at info level.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session status includes elevated mode (e.g. `elevated=ask`, `elevated=full`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
