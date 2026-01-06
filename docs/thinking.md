---
summary: "Directive syntax for /think + /verbose and how they affect model reasoning"
read_when:
  - Adjusting thinking or verbose directive parsing or defaults
---
# Thinking Levels (/think directives)

## What it does
- Inline directive in any inbound body: `/t <level>`, `/think:<level>`, or `/thinking <level>`.
- Levels (aliases): `off | minimal | low | medium | high`
  - minimal → “think”
  - low → “think hard”
  - medium → “think harder”
  - high → “ultrathink” (max budget)
  - `highest`, `max` map to `high`.

## Resolution order
1. Inline directive on the message (applies only to that message).
2. Session override (set by sending a directive-only message).
3. Global default (`agent.thinkingDefault` in config).
4. Fallback: low for reasoning-capable models; off otherwise.

## Setting a session default
- Send a message that is **only** the directive (whitespace allowed), e.g. `/think:medium` or `/t high`.
- That sticks for the current session (per-sender by default); cleared by `/think:off` or session idle reset.
- Confirmation reply is sent (`Thinking level set to high.` / `Thinking disabled.`). If the level is invalid (e.g. `/thinking big`), the command is rejected with a hint and the session state is left unchanged.

## Application by agent
- **Embedded Pi**: the resolved level is passed to the in-process Pi agent runtime.

## Verbose directives (/verbose or /v)
- Levels: `on|full` or `off` (default).
- Directive-only message toggles session verbose and replies `Verbose logging enabled.` / `Verbose logging disabled.`; invalid levels return a hint without changing state.
- Inline directive affects only that message; session/global defaults apply otherwise.
- When verbose is on, agents that emit structured tool results (Pi, other JSON agents) send each tool result back as its own metadata-only message, prefixed with `<emoji> <tool-name>: <arg>` when available (path/command); the tool output itself is not forwarded. These tool summaries are sent as soon as each tool finishes (separate bubbles), not as streaming deltas. If you toggle `/verbose on|off` while a run is in-flight, subsequent tool bubbles honor the new setting.

## Related
- Elevated mode docs live in [`docs/elevated.md`](https://docs.clawd.bot/elevated).

## Heartbeats
- Heartbeat probe body is `HEARTBEAT`. Inline directives in a heartbeat message apply as usual (but avoid changing session defaults from heartbeats).

## Web chat UI
- The web chat thinking selector mirrors the session's stored level from the inbound session store/config when the page loads.
- Picking another level applies only to the next message (`thinkingOnce`); after sending, the selector snaps back to the stored session level.
- To change the session default, send a `/think:<level>` directive (as before); the selector will reflect it after the next reload.
