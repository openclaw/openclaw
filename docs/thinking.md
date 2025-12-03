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
3. Global default (`inbound.reply.thinkingDefault` in config).
4. Fallback: off.

## Setting a session default
- Send a message that is **only** the directive (whitespace allowed), e.g. `/think:medium` or `/t high`.
- That sticks for the current session (per-sender by default); cleared by `/think:off` or session idle reset.
- Confirmation reply is sent (`Thinking level set to high.` / `Thinking disabled.`). If the level is invalid (e.g. `/thinking big`), the command is rejected with a hint and the session state is left unchanged.

## Application by agent
- **Pi/Tau**: injects `--thinking <level>` (skipped for `off`).
- **Claude & other text agents**: appends the cue word to the prompt text as above.

## Heartbeats
- Heartbeat probe body is `HEARTBEAT /think:high`, so it always asks for max thinking on the probe. Inline directive wins; session/global defaults are used only when no directive is present.
