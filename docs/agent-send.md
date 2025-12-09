# Plan: `clawdis agent` (direct-to-agent invocation)

Goal: Add a CLI subcommand that talks directly to the configured agent command (no WhatsApp send), while reusing the same session handling and config clawdis already uses for auto-replies.

## Why
- Sometimes we want to poke the agent directly (same prompt templates/sessions) without sending a WhatsApp message.
- Current flows (`send`, relay, directives) always route through WhatsApp or add wrapping text; we need a clean “talk to agent now” tool.

## Behavior
- Command: `clawdis agent`
- Required: `--message <text>`
- Session selection:
  - If `--session-id` given, use it.
  - Else if `--to <e164>` given, derive session key like auto-reply (`per-sender`, same normalization) and load/create session id from `session store` path in config.
  - Else error (“need --to or --session-id”).
- Runs the same external command as auto-reply: `inbound.reply.command` from config (honors `reply.session` options: sendSystemOnce, sendSystemOnce=false, typing, timeouts, etc.).
- Uses the same templating rules for Body as command mode, but **skips** WhatsApp-specific wrappers (group intro, media hints). Keep session intro/bodyPrefix if sendSystemOnce is false, otherwise follow session config.
- Thinking/verbose:
  - Accept flags `--thinking <off|minimal|low|medium|high>` and `--verbose <on|off>`.
  - Persist into session store (like directive-only flow) and inject into the command invocation.
- Output:
  - Default: print the agent’s text reply to stdout.
  - `--json` flag: print full payload (text, any media URL, timing).
- Does **not** send anything to WhatsApp; purely local agent run.

## Flags (proposed)
- `--message, -m <text>` (required)
- `--to, -t <e164>` (derive session)
- `--session-id <uuid>` (override)
- `--thinking <off|minimal|low|medium|high>`
- `--verbose <on|off>`
- `--json` (structured output)
- `--timeout <sec>` (override command timeout)

## Implementation steps
1) CLI:
   - Add subcommand in `src/cli/program.ts`.
   - Wire options, setVerbose, createDefaultDeps.
2) Command handler (new file `src/commands/agent.ts`):
   - Load config.
   - Resolve session store + session id (reuse `deriveSessionKey`, `loadSessionStore`, `saveSessionStore`).
   - Apply thinking/verbose overrides and persist to session entry.
   - Build command body (no WhatsApp wrappers; honor sessionIntro/bodyPrefix as per config).
   - Call `runCommandWithTimeout` (same as auto-reply) and parse response (reuse splitter for MEDIA, etc.).
   - Return text (and mediaUrl) to stdout / JSON.
3) Share logic:
   - Extract helper(s) from `auto-reply/reply.ts` if needed (session + thinking persistence) to avoid duplication.
4) Tests:
   - Unit tests for handler: session creation, thinking persistence, resume with `--session-id`, JSON output.
   - Snapshot of command args to ensure no WhatsApp wrappers.
5) Docs:
   - Add usage examples to CLI help and README.

## Out of scope (for now)
- Chat directives `/cmd` in WhatsApp. (Can reuse the same handler later.)
- Media input/attachments. Start text-only; extend later if needed.
