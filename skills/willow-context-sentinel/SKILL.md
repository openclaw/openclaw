---
name: willow-context-sentinel
description: Use when you need to check whether the current session is approaching context limits and decide whether to compact, hand off, or continue. Implements a cascading model protocol for Willow/OpenClaw stacks on Linux — monitoring prompt_count as a context proxy and routing to strategic-compact or willow_task_submit as needed.
metadata: { "openclaw": { "emoji": "🧭", "os": ["linux"], "requires": { "bins": ["bash"] } } }
---

# Willow Context Sentinel

Monitor session context usage and apply a cascading relief protocol before context exhaustion silently degrades response quality.

| Output            | Meaning                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| **STATUS_OK**     | prompt_count < 15 — session is healthy, continue normally                  |
| **COMPACT_NOW**   | prompt_count 15–25 — approaching limit, invoke strategic-compact           |
| **HANDOFF_NOW**   | prompt_count > 25 — near ceiling, invoke handoff + willow_task_submit      |
| **POSTGRES_DOWN** | session_anchor.json reports postgres as down — fix infra before proceeding |

## When to use

- **Heartbeat**: run at the start of every session and every ~10 prompts
- **Before large tasks**: check before any operation that will generate many tool calls or long output
- **Proactively**: if responses feel slower, less coherent, or you notice unusual hedging, run this check immediately
- **After a branch merge or plan execution**: context spikes are common at transition points

## Step 1 — Run the sentinel script

```bash
bash {baseDir}/scripts/check_context.sh
```

The script reads two Willow state files:

- `~/.willow/anchor_state.json` — `prompt_count` field (context proxy)
- `~/.willow/session_anchor.json` — `postgres` status field

## Step 2 — Interpret the output

Run the script and act on the single-line output:

### STATUS_OK

No action needed. Session is healthy.

```
STATUS_OK
```

Continue with the current task. Optionally note the prompt_count in a heartbeat log entry.

### COMPACT_NOW

```
COMPACT_NOW
```

Context is filling. Invoke the `strategic-compact` skill immediately before proceeding:

```
/strategic-compact
```

After compact completes, re-run the sentinel. If it still reports `COMPACT_NOW` or escalates to `HANDOFF_NOW`, proceed to the handoff protocol below.

### HANDOFF_NOW

```
HANDOFF_NOW
```

Session is near the context ceiling. Invoke the `handoff` skill and submit the next task to Willow:

1. Run `/handoff` to produce a structured handoff document
2. Call `willow_task_submit` with the next bite as the task body
3. End the session cleanly — do not attempt further large operations

### POSTGRES_DOWN

```
POSTGRES_DOWN
```

Willow's backing store is unreachable. KB reads and writes will fail silently. Do not proceed with memory-dependent tasks. Check the Willow server status:

```bash
willow status
# or
systemctl status willow-postgres
```

Resolve the infra issue before resuming work.

## Step 3 — Integration with HEARTBEAT.md

Add a sentinel call to your heartbeat template so it runs automatically. Minimal example:

```markdown
## Heartbeat — {timestamp}

**Sentinel:** `bash ~/.openclaw/skills/willow-context-sentinel/scripts/check_context.sh`

| Check    | Result    |
| -------- | --------- |
| Context  | STATUS_OK |
| Postgres | up        |

Next bite: {next_task}
```

If the sentinel output is anything other than `STATUS_OK`, record the output and the action taken before moving on.

## Cascading protocol reference

```
Claude Sonnet 4.6
    │
    ├─ prompt_count ≥ 15  →  COMPACT_NOW  →  /strategic-compact
    │                              │
    │                              └─ still ≥ 15 after compact
    │                                         │
    └─ prompt_count > 25  →  HANDOFF_NOW  →  /handoff + willow_task_submit
```

Relief valves are applied in order. Skip to `HANDOFF_NOW` if compact has already been run in this session and context remains high.

## Notes

- `prompt_count` is a proxy, not a direct token count. Actual context consumption varies by response length. Treat thresholds as conservative triggers, not hard limits.
- Both state files (`anchor_state.json`, `session_anchor.json`) are written by the Willow server. If either file is missing, the script outputs `STATUS_OK` and logs a warning to stderr — it fails open, not closed.
- This skill does not modify any state files. It is read-only and safe to run at any time.
