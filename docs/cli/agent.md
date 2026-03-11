---
summary: "CLI reference for `openclaw agent` (send one agent turn via the Gateway)"
read_when:
  - You want to run one agent turn from scripts (optionally deliver reply)
title: "agent"
---

# `openclaw agent`

Run an agent turn via the Gateway (use `--local` for embedded).
Use `--agent <id>` to target a configured agent directly.

Related:

- Agent send tool: [Agent send](/tools/agent-send)

## Options

| Flag | Description |
|------|-------------|
| `--model <id>` | Override the model for this turn only (e.g. `openai/gpt-4o`). Not persisted to the session — applies to the current invocation only. Throws an error if the model id is invalid or not in the configured allowlist. |

## Examples

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
openclaw agent --agent main --model minimax/MiniMax-M2.5-highspeed --message "Hello"
```

> **Per-turn model override:** `--model <id>` sets the model for a single turn without
> modifying the session's stored configuration. This is useful in CI/pipeline scripts
> where you need a specific model for one invocation. If the model id is unrecognized
> or not in the configured allowlist, the command fails with an explicit error.

## Notes

- When this command triggers `models.json` regeneration, SecretRef-managed provider credentials are persisted as non-secret markers (for example env var names or `secretref-managed`), not resolved secret plaintext.
