# JSONL Recovery Reference

## Overview

The JSONL Recovery script (`scripts/jsonl_recovery.py`) recovers delta assistant messages from OpenClaw session transcript files written after the last checkpoint timestamp. It scans `~/.openclaw/agents/*/sessions/` (and falls back to `~/.openclaw/workspace/memory/`) for `.jsonl` files, handles both flat and envelope message formats, and appends recovered content to the session checkpoint.

## When to Use

Use this script when:
- A session was interrupted before a checkpoint was written
- You need to recover assistant messages from after the last checkpoint
- You want to verify which session transcript files are available

## Commands

| Command | Description |
|---------|-------------|
| `recover` | Find assistant messages after checkpoint timestamp and append to checkpoint |
| `find-sessions` | List all `.jsonl` session files found, sorted by modification time |
| `status` | Print checkpoint timestamp and count of JSONL files found |

## Usage

```bash
# Recover delta messages after last checkpoint
python3 {baseDir}/scripts/jsonl_recovery.py recover
```

```bash
# List available session transcript files
python3 {baseDir}/scripts/jsonl_recovery.py find-sessions
```

```bash
# Show checkpoint and session file status
python3 {baseDir}/scripts/jsonl_recovery.py status
```

## Message Format Support

The script handles two JSONL record formats used by OpenClaw:

- **Flat format**: `{"role": "assistant", "content": "..."}`
- **Envelope format**: `{"type": "message", "message": {"role": "assistant", "content": "..."}}`

## Output

When messages are recovered, a `### Recovered Delta` section is appended to the checkpoint file with up to 5 messages (configurable via `MAX_MESSAGES`) and a maximum of 2048 bytes of content.

## Timestamp Handling

The script reads the `_last_updated:` field from the checkpoint file. Both standard ISO format (`2026-04-03T23:00:00+00:00`) and shorthand UTC (`2026-04-03T23:00Z`) are supported.

## Error Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | No checkpoint timestamp found or other error |
