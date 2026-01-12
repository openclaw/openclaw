---
summary: "How Clawdbot memory works (workspace files + automatic memory flush)"
read_when:
  - You want the memory file layout and workflow
  - You want to tune the automatic pre-compaction memory flush
---
# Memory

Clawdbot memory is **plain Markdown in the agent workspace**. The files are the
source of truth; the model only “remembers” what gets written to disk.

## Memory files (Markdown)

The default workspace layout uses two memory layers:

- `memory/YYYY-MM-DD.md`
  - Daily log (append-only).
  - Read today + yesterday at session start.
- `MEMORY.md` (optional)
  - Curated long-term memory.
  - **Only load in the main, private session** (never in group contexts).

These files live under the workspace (`agents.defaults.workspace`, default
`~/clawd`). See [Agent workspace](/concepts/agent-workspace) for the full layout.

## When to write memory

- Decisions, preferences, and durable facts go to `MEMORY.md`.
- Day-to-day notes and running context go to `memory/YYYY-MM-DD.md`.
- If someone says “remember this,” write it down (don’t keep it in RAM).

## Automatic memory flush (pre-compaction ping)

When a session is **close to auto-compaction**, Clawdbot triggers a **silent
agentic turn** that reminds the model to write durable memory **before** the
context is compacted. The default prompt encourages the model to respond with
`NO_REPLY` when there’s nothing to store, so the user never sees this turn.

This is controlled by `agents.defaults.compaction.memoryFlush`:

```json5
{
  agents: {
    defaults: {
      compaction: {
        reserveTokensFloor: 20000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store."
        }
      }
    }
  }
}
```

Details:
- **Soft threshold**: flush triggers when the session token estimate crosses
  `contextWindow - reserveTokensFloor - softThresholdTokens`.
- **Silent** by default: prompts include `NO_REPLY` so nothing is delivered.
- **One flush per compaction cycle** (tracked in `sessions.json`).

For the full compaction lifecycle, see
[Session management + compaction](/reference/session-management-compaction).
