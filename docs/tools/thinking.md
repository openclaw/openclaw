---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Directive syntax for /think + /verbose and how they affect model reasoning"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adjusting thinking or verbose directive parsing or defaults（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Thinking Levels"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Thinking Levels (/think directives)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What it does（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Inline directive in any inbound body: `/t <level>`, `/think:<level>`, or `/thinking <level>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Levels (aliases): `off | minimal | low | medium | high | xhigh` (GPT-5.2 + Codex models only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - minimal → “think”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - low → “think hard”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - medium → “think harder”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - high → “ultrathink” (max budget)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - xhigh → “ultrathink+” (GPT-5.2 + Codex models only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `x-high`, `x_high`, `extra-high`, `extra high`, and `extra_high` map to `xhigh`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `highest`, `max` map to `high`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Z.AI (`zai/*`) only supports binary thinking (`on`/`off`). Any non-`off` level is treated as `on` (mapped to `low`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Resolution order（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Inline directive on the message (applies only to that message).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Session override (set by sending a directive-only message).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Global default (`agents.defaults.thinkingDefault` in config).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Fallback: low for reasoning-capable models; off otherwise.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Setting a session default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Send a message that is **only** the directive (whitespace allowed), e.g. `/think:medium` or `/t high`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- That sticks for the current session (per-sender by default); cleared by `/think:off` or session idle reset.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Confirmation reply is sent (`Thinking level set to high.` / `Thinking disabled.`). If the level is invalid (e.g. `/thinking big`), the command is rejected with a hint and the session state is left unchanged.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Send `/think` (or `/think:`) with no argument to see the current thinking level.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Application by agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Embedded Pi**: the resolved level is passed to the in-process Pi agent runtime.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Verbose directives (/verbose or /v)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Levels: `on` (minimal) | `full` | `off` (default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Directive-only message toggles session verbose and replies `Verbose logging enabled.` / `Verbose logging disabled.`; invalid levels return a hint without changing state.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/verbose off` stores an explicit session override; clear it via the Sessions UI by choosing `inherit`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Inline directive affects only that message; session/global defaults apply otherwise.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Send `/verbose` (or `/verbose:`) with no argument to see the current verbose level.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When verbose is on, agents that emit structured tool results (Pi, other JSON agents) send each tool call back as its own metadata-only message, prefixed with `<emoji> <tool-name>: <arg>` when available (path/command). These tool summaries are sent as soon as each tool starts (separate bubbles), not as streaming deltas.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When verbose is `full`, tool outputs are also forwarded after completion (separate bubble, truncated to a safe length). If you toggle `/verbose on|full|off` while a run is in-flight, subsequent tool bubbles honor the new setting.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Reasoning visibility (/reasoning)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Levels: `on|off|stream`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Directive-only message toggles whether thinking blocks are shown in replies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When enabled, reasoning is sent as a **separate message** prefixed with `Reasoning:`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `stream` (Telegram only): streams reasoning into the Telegram draft bubble while the reply is generating, then sends the final answer without reasoning.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Alias: `/reason`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Send `/reasoning` (or `/reasoning:`) with no argument to see the current reasoning level.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Elevated mode docs live in [Elevated mode](/tools/elevated).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Heartbeats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeat probe body is the configured heartbeat prompt (default: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Inline directives in a heartbeat message apply as usual (but avoid changing session defaults from heartbeats).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeat delivery defaults to the final payload only. To also send the separate `Reasoning:` message (when available), set `agents.defaults.heartbeat.includeReasoning: true` or per-agent `agents.list[].heartbeat.includeReasoning: true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Web chat UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The web chat thinking selector mirrors the session's stored level from the inbound session store/config when the page loads.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Picking another level applies only to the next message (`thinkingOnce`); after sending, the selector snaps back to the stored session level.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- To change the session default, send a `/think:<level>` directive (as before); the selector will reflect it after the next reload.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
