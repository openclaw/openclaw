# Experimental: Ops Board, Project Radar, Replay Trace

These scripts are intentionally scoped as local operator tools and do not change OpenClaw runtime behavior.

## 1) Project Radar

Scan a code directory for git repos and summarize branch health.

```bash
pnpm exp:project-radar
pnpm exp:project-radar -- --root ~/Documents/Code --json
```

Output fields:

- branch
- ahead/behind vs upstream (when configured)
- dirty working tree
- last commit age
- package manager hints (`package.json`, `Cargo.toml`, `go.mod`)

## 2) Ops Board Snapshot

Generate a local operational snapshot from common OpenClaw paths.

```bash
pnpm exp:ops-board
pnpm exp:ops-board -- --json
```

Checks:

- `~/.openclaw/state` file/dir counts
- `~/.openclaw/workspace/memory` files modified in last 48h
- heartbeat file status (`HEARTBEAT.md`)
- latest log-like files in state directory

## 3) Replay Trace Foundation

Parse a JSONL trace file and print a deterministic timeline.

```bash
pnpm exp:replay-trace -- /path/to/trace.jsonl
pnpm exp:replay-trace -- /path/to/trace.jsonl --strict
pnpm exp:replay-trace -- /path/to/trace.jsonl --json
```

Behavior:

- Malformed JSONL lines are reported with line numbers
- `--strict` returns non-zero when malformed lines exist
