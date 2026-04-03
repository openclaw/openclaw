# Context Restore Plugin

An example OpenClaw plugin that prevents **identity and context drift** in
long-running agents after LCM (Lossless Context Management) compaction.

## The Problem

OpenClaw agents maintain context by keeping recent conversation history in the
active window. When that window fills up, LCM compacts older messages into a
summary. This is efficient — but it has a side effect: the agent may lose
awareness of its own configuration files (guidelines, persona, security rules,
memory) that were only read at session start.

After compaction, an agent that has not re-read its core files may:

- Forget role-specific guidelines or tone
- Drift away from security or safety rules
- Miss recent memory written earlier in the session
- Answer questions as if it had no prior context

## The Solution: Two Layers

This plugin uses two complementary hooks:

### Layer 1 — Static System Anchor (every turn)

On every turn, the plugin appends a short configurable text block to the system
prompt via `appendSystemContext`. Because this text is **stable across turns**,
Anthropic-hosted models can cache it — the marginal token cost after the first
turn is effectively zero.

Use this layer for brief, always-relevant reminders: the agent's name, a pointer
to its config files, or its most important rule.

### Layer 2 — Post-Compaction File Restore

After compaction fires (the `after_compaction` hook), the plugin enqueues a
system event instructing the agent to re-read a configurable list of files.
The agent processes this silently (replying `NO_REPLY`) before the next user
turn, fully restoring its context.

Use this layer for the full set of files that define the agent's identity and
working state.

## Configuration

Add to your agent config (e.g. `openclaw.json` under `plugins`):

```json
{
  "id": "context-restore",
  "config": {
    "anchorText": "CONTEXT ANCHOR: You are MyAgent. Re-read AGENTS.md and SOUL.md if your context was recently compacted.",
    "restoreFiles": ["SOUL.md", "AGENTS.md", "SECURITY.md", "memory/2025-01-15.md"],
    "sessionPrefix": "agent:main:"
  }
}
```

### Options

| Key             | Type       | Default                                                      | Description                                                                                |
| --------------- | ---------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `anchorText`    | `string`   | A generic reminder to re-read config files after compaction. | Text appended to the system prompt every turn. Keep it short for best cache hit rate.      |
| `restoreFiles`  | `string[]` | `["AGENTS.md"]`                                              | Files to re-read after compaction, relative to the agent workspace.                        |
| `sessionPrefix` | `string`   | `""` (all sessions)                                          | If set, only applies to sessions whose key starts with this prefix (e.g. `"agent:main:"`). |

### Dynamic file paths

`restoreFiles` can include dynamic tokens that the agent will resolve at
restore time. For example, to include today's memory note:

```json
"restoreFiles": ["AGENTS.md", "SOUL.md", "memory/YYYY-MM-DD.md"]
```

The agent is instructed to read the file named with today's date substituted
for `YYYY-MM-DD`.

## How It Works

```
Every turn
  └─ before_prompt_build → appendSystemContext(anchorText)
                           (Anthropic caches this; ~0 marginal tokens)

After compaction
  └─ after_compaction → enqueueSystemEvent(
       "Re-read: SOUL.md, AGENTS.md, SECURITY.md, memory/YYYY-MM-DD.md"
     )
       └─ agent turn: reads files, replies NO_REPLY (silent)
```

## Hooks Used

| Hook                  | Purpose                                    |
| --------------------- | ------------------------------------------ |
| `before_prompt_build` | Inject static anchor into system prompt.   |
| `after_compaction`    | Trigger file-restore after LCM compaction. |

Both hooks are stable public APIs available since OpenClaw 2026.3.7.

## Extending This Example

- **Group agents**: set `sessionPrefix` per-agent to target only the sessions
  that need it (e.g. `"agent:mygroup:"`).
- **Multiple agents, different files**: deploy one plugin instance per agent
  with different `restoreFiles` lists.
- **Minimal mode**: omit `restoreFiles` and rely only on `anchorText` for a
  lightweight, zero-side-effect anchor.
