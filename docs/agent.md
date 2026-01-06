---
summary: "Agent runtime (embedded p-mono), workspace contract, and session bootstrap"
read_when:
  - Changing agent runtime, workspace bootstrap, or session behavior
---
# Agent Runtime 🤖

CLAWDBOT runs a single embedded agent runtime derived from **p-mono** (internal name: **p**).

## Workspace (required)

CLAWDBOT uses a single agent workspace directory (`agent.workspace`) as the agent’s **only** working directory (`cwd`) for tools and context.

Recommended: use `clawdbot setup` to create `~/.clawdbot/clawdbot.json` if missing and initialize the workspace files.

If `agent.sandbox` is enabled, non-main sessions can override this with
per-session workspaces under `agent.sandbox.workspaceRoot` (see
[`docs/configuration.md`](https://docs.clawd.bot/configuration)).

## Bootstrap files (injected)

Inside `agent.workspace`, CLAWDBOT expects these user-editable files:
- `AGENTS.md` — operating instructions + “memory”
- `SOUL.md` — persona, boundaries, tone
- `TOOLS.md` — user-maintained tool notes (e.g. `imsg`, `sag`, conventions)
- `BOOTSTRAP.md` — one-time first-run ritual (deleted after completion)
- `IDENTITY.md` — agent name/vibe/emoji
- `USER.md` — user profile + preferred address

On the first turn of a new session, CLAWDBOT injects the contents of these files directly into the agent context.

If a file is missing, CLAWDBOT injects a single “missing file” marker line (and `clawdbot setup` will create a safe default template).

`BOOTSTRAP.md` is only created for a **brand new workspace** (no other bootstrap files present). If you delete it after completing the ritual, it should not be recreated on later restarts.

To disable bootstrap file creation entirely (for pre-seeded workspaces), set:

```json5
{ agent: { skipBootstrap: true } }
```

## Built-in tools (internal)

p’s embedded core tools (read/bash/edit/write and related internals) are defined in code and always available. `TOOLS.md` does **not** control which tools exist; it’s guidance for how *you* want them used.

## Skills

Clawdbot loads skills from three locations (workspace wins on name conflict):
- Bundled (shipped with the install)
- Managed/local: `~/.clawdbot/skills`
- Workspace: `<workspace>/skills`

Skills can be gated by config/env (see `skills` in [`docs/configuration.md`](https://docs.clawd.bot/configuration)).

## p-mono integration

Clawdbot reuses pieces of the p-mono codebase (models/tools), but **session management, discovery, and tool wiring are Clawdbot-owned**.

- No p-coding agent runtime.
- No `~/.pi/agent` or `<workspace>/.pi` settings are consulted.

## Peter @ steipete (only)

Apply these notes **only** when the user is Peter Steinberger at steipete.

- Gateway runs on the **Mac Studio in London**.
- Primary work computer: **MacBook Pro**.
- Peter travels between **Vienna** and **London**; there are two networks bridged via **Tailscale**.
- For debugging, connect to the Mac Studio (London) or MacBook Pro (primary).
- There is also an **M1 MacBook Pro** on the Vienna tailnet you can use to access the Vienna network.
- Nodes can be accessed via the `clawdbot` binary (`pnpm clawdbot` in `~/Projects/clawdbot`).
- See also `skills/clawdbot*` for node/browser/canvas/cron usage.

## Sessions

Session transcripts are stored as JSONL at:
- `~/.clawdbot/agents/<agentId>/sessions/<SessionId>.jsonl`

The session ID is stable and chosen by CLAWDBOT.
Legacy Pi/Tau session folders are **not** read.

## Steering while streaming

When queue mode is `steer`, inbound messages are injected into the current run.
The queue is checked **after each tool call**; if a queued message is present,
remaining tool calls from the current assistant message are skipped (error tool
results with "Skipped due to queued user message."), then the queued user
message is injected before the next assistant response.

When queue mode is `followup` or `collect`, inbound messages are held until the
current turn ends, then a new agent turn starts with the queued payloads. See
[`docs/queue.md`](https://docs.clawd.bot/queue) for mode + debounce/cap behavior.

Block streaming sends completed assistant blocks as soon as they finish; disable
via `agent.blockStreamingDefault: "off"` if you only want the final response.
Tune the boundary via `agent.blockStreamingBreak` (`text_end` vs `message_end`; defaults to text_end).
Control soft block chunking with `agent.blockStreamingChunk` (defaults to
800–1200 chars; prefers paragraph breaks, then newlines; sentences last).
Verbose tool summaries are emitted at tool start (no debounce); Control UI
streams tool output via agent events when available.

## Configuration (minimal)

At minimum, set:
- `agent.workspace`
- `whatsapp.allowFrom` (strongly recommended)

---

*Next: [Group Chats](https://docs.clawd.bot/group-messages)* 🦞
