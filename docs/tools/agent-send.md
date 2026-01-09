---
summary: "Direct `clawdbot agent` CLI runs (with optional delivery)"
read_when:
  - Adding or modifying the agent CLI entrypoint
---
# `clawdbot agent` (direct agent runs)

`clawdbot agent` runs a single agent turn without needing an inbound chat message.
By default it goes **through the Gateway**; add `--local` to force the embedded
runtime on the current machine.

## Behavior

- Required: `--message <text>`
- Session selection:
  - `--to <E.164>` derives the session key (normal direct-chat routing), **or**
  - `--session-id <id>` reuses an existing session by id
- Runs the same embedded agent runtime as normal inbound replies.
- Thinking/verbose flags persist into the session store.
- Output:
  - default: prints reply text (plus `MEDIA:<url>` lines)
  - `--json`: prints structured payload + metadata
- Optional delivery back to a provider with `--deliver` + `--provider`.

If the Gateway is unreachable, the CLI **falls back** to the embedded local run.

## Examples

```bash
clawdbot agent --to +15555550123 --message "status update"
clawdbot agent --session-id 1234 --message "Summarize inbox" --thinking medium
clawdbot agent --to +15555550123 --message "Trace logs" --verbose on --json
clawdbot agent --to +15555550123 --message "Summon reply" --deliver
```

## Flags

- `--local`: run locally (requires provider keys in your shell)
- `--deliver`: send the reply to the chosen provider (requires `--to`)
- `--provider`: `whatsapp|telegram|discord|slack|signal|imessage` (default: `whatsapp`)
- `--thinking <off|minimal|low|medium|high>`: persist thinking level
- `--verbose <on|off>`: persist verbose level
- `--timeout <seconds>`: override agent timeout
- `--json`: output structured JSON
