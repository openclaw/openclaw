# JSONL Recovery Reference

## Overview

The JSONL Recovery script (`scripts/jsonl_recovery.py`) repairs corrupted or incomplete JSONL conversation log files. It scans line by line, validates JSON structure, and reconstructs a clean output file.

## When to Use

Use this script when:
- A session log file contains malformed JSON lines
- An interrupted write operation left partial records
- You need to extract valid entries from a damaged log

## Commands

| Command | Description |
|---------|-------------|
| `recover` | Scan and recover valid lines from a JSONL file |
| `validate` | Check file integrity without writing output |
| `stats` | Print summary of valid vs. invalid line counts |

## Usage

```bash
python3 {baseDir}/scripts/jsonl_recovery.py recover --input {baseDir}/logs/session.jsonl --output {baseDir}/logs/session_recovered.jsonl
```

```bash
python3 {baseDir}/scripts/jsonl_recovery.py validate --input {baseDir}/logs/session.jsonl
```

## Output Format

The recovered file contains only valid JSON lines, one per line. Invalid lines are logged to stderr with their line numbers for inspection.

## Error Codes

| Code | Meaning |
|------|---------|
| 0 | Success, all lines valid |
| 1 | Partial recovery, some lines skipped |
| 2 | Input file not found or unreadable |
| 3 | Output file could not be written |

## Integration

Call this script from your HEARTBEAT.md routine when log corruption is detected:

```bash
python3 {baseDir}/scripts/jsonl_recovery.py validate --input {baseDir}/logs/session.jsonl || \
  python3 {baseDir}/scripts/jsonl_recovery.py recover --input {baseDir}/logs/session.jsonl --output {baseDir}/logs/session.jsonl
```
