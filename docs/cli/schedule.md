# schedule

Local scheduler helpers (prototype).

This command manages a local schedule file in your OpenClaw state directory:

- `~/.openclaw/schedule.json` — job definitions
- `~/.openclaw/schedule-runs.jsonl` — append-only run log

## Commands

### List jobs

```bash
openclaw schedule list
openclaw schedule list --json
```

### Add/update a job

Commands are executed **without a shell** (no interpolation): the command and each argument are passed as a separate argv element.

```bash
openclaw schedule add hello \
  --description "prints hello" \
  --cmd node \
  --arg -e \
  --arg "console.log('hello')"
```

Optional:

- `--cwd <dir>`
- `--env KEY=VALUE` (repeatable)

### Remove a job

```bash
openclaw schedule remove hello
```

### Run a job immediately

This takes a per-job lock (in `~/.openclaw/schedule-locks/`) to prevent overlapping runs.

```bash
openclaw schedule run-now hello
openclaw schedule run-now hello --json
```
