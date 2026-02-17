# feat: add `/save` command and pre-reset memory flush

Closes #8185

## Summary

When a user triggers `/new` or `/reset`, the session is discarded without giving the agent a chance to save important context. This PR adds:

1. **`/save` command** — Manually trigger a memory flush to disk at any time
2. **Pre-reset memory flush** — Automatically runs a memory save turn before `/new` and `/reset` when `compaction.memoryFlush` is enabled (default: `true`)

## Changes

### New file: `src/auto-reply/reply/commands-save.ts`
- `runMemorySave()` — Reusable memory save function that runs a flush turn via the embedded agent
- `runPreResetMemoryFlush()` — Reset-specific variant with tailored prompts ("Session is being reset, save important context now")
- `handleSaveCommand` — `/save` command handler with auth checks and error handling

### Modified: `src/auto-reply/reply/commands-core.ts`
- Added pre-reset memory flush before the existing reset/hook logic
- Only triggers when `memoryFlush` is configured (respects existing user settings)
- Runs before internal hooks and `before_reset` plugin hooks, so memories are saved while session history is still available

### Modified: `src/tui/commands.ts`
- Registered `/save` in the TUI command list

### New test: `src/auto-reply/reply/commands-save.test.ts`
- 7 tests covering: command routing, auth checks, missing session id, agent-running guard, reset-specific prompts
- All passing

## How it works

### `/save`
```
User: /save
Agent: (runs memory flush turn, writes to memory/YYYY-MM-DD.md)
→ 💾 Memory saved.
```

### Pre-reset flush
```
User: /new
Agent: (pre-reset flush: saves important context to memory files)
→ (session reset proceeds normally)
→ (fresh session greeting)
```

## Design decisions

- **Reuses existing `memoryFlush` infrastructure** — same prompt resolution, date formatting, and config
- **No new config options needed** — piggybacks on `compaction.memoryFlush.enabled` (default: true)
- **Non-blocking on failure** — if the flush fails, the reset still proceeds (logged as verbose warning)
- **Auth-gated** — only authorized senders can trigger `/save`

## Known limitations

- Pre-reset flush currently covers the **channel command path** (Telegram, Discord, WhatsApp, TUI, etc.) but not the **gateway API direct reset path** (`agent.ts`). The gateway path lacks the resolved model/provider context needed to run an agent turn at reset time. This could be addressed in a follow-up.

## Testing

```bash
pnpm exec vitest run src/auto-reply/reply/commands-save.test.ts
# 7 tests passing
```

Type-checked with `tsc --noEmit` — no new errors.
