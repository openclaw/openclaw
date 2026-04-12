---
name: mclog
description: Read runtime logs captured by mclog. Use when the user mentions a runtime error, crash, or misbehavior in a local dev process (npm run dev, bun run dev, python server.py, openclaw gateway, voice service, etc.) and a .mclogs/ directory exists in the project.
metadata: { "openclaw": { "emoji": "📄", "requires": { "bins": ["bash", "tail"] } } }
---

# mclog

Lightweight capture + tail of arbitrary command output, so agents can inspect actual runtime logs instead of guessing from error descriptions. Lives at `C:\AI\tools\mclog` (Git Bash shim).

## Trigger

Use this skill when **both** are true:

1. The user describes a runtime problem — keywords: "error", "crash", "broken", "not working", "failing", "died", "hangs", "spinner forever", "500", "build failed".
2. A `.mclogs/` directory exists in the project root (or a parent of the cwd the user is working in).

Also trigger if the user explicitly names a captured run: "check the dev log", "what did bun say", "tail the server output".

If trigger (1) fires but no `.mclogs/` exists, offer the capture one-liner (see below) and stop — don't speculate.

## How the user captures logs

One-time per run, prefix the command with `mclog`:

```bash
bash /c/AI/tools/mclog bun run dev
bash /c/AI/tools/mclog npm run dev
bash /c/AI/tools/mclog node server.js
bash /c/AI/tools/mclog python manage.py runserver
bash /c/AI/tools/mclog openclaw gateway start
```

Exit code is preserved. The command runs normally; output is teed to `./.mclogs/latest.txt` and `./.mclogs/<sanitized-name>.txt` simultaneously. Nothing else changes for the user.

## How to read logs (agent actions)

Before asking the user clarifying questions, **check the logs first**:

```bash
bash /c/AI/tools/mclog tail                 # latest run of anything
bash /c/AI/tools/mclog tail -n 100          # last 100 lines of latest
bash /c/AI/tools/mclog tail dev             # latest run matching 'dev' in filename
bash /c/AI/tools/mclog tail dev -n 200      # last 200 lines of latest dev-matching run
bash /c/AI/tools/mclog tail -f              # follow (rarely useful in a CC turn)
bash /c/AI/tools/mclog list                 # index of captured runs in project
```

The first line of every tail output is a `# <path>` comment pointing to the source file, so you know exactly which capture you're reading.

## Auto-behavior

When the trigger fires:

1. Check `.mclogs/` exists. If not, suggest the capture prefix and wait.
2. Run `mclog list` to see what's captured.
3. Run `mclog tail <query> -n 100` matching the most likely command (e.g. `dev`, `server`, `gateway`, or whatever the user mentioned).
4. Read the actual error(s), then respond with a root-cause hypothesis or a targeted clarifying question — **not** a generic "what's the error message?"

Don't dump raw log content back at the user unless they ask for it. Summarize what you found.

## File layout

Per project:

```
.mclogs/
├── latest.txt                          # most recent run of anything
├── npm-run-dev.txt                     # most recent run of `npm run dev`
├── bun-run-dev.txt                     # most recent run of `bun run dev`
├── openclaw-gateway-start.txt
└── .history/
    ├── npm-run-dev-1775000000.txt      # timestamped history, 20 newest per command
    └── ...
```

Every log file starts with a header block:

```
# mclog: <command and args>
# cwd:   <where it was run>
# time:  YYYY-MM-DD HH:MM:SS
# ---
<stdout+stderr>
# ---
# exit: <code>
```

Use the header to confirm you're reading the right run.

## Git hygiene

If the project is a git repo and `.mclogs/` is not in `.gitignore`, suggest adding it. Don't modify `.gitignore` without explicit user approval.

```
.mclogs/
```

## Scope / limits

- **Per-project only.** Each project gets its own `.mclogs/` in its cwd. Override with `MCLOG_DIR=/some/path` if you need central capture.
- **No PTY emulation on Windows.** Most dev tools auto-disable colors when stdout is not a TTY — that's actually cleaner for grep. Tools that insist on raw TTY (interactive REPLs, TUIs) won't play nicely; use them directly.
- **Not a replacement for:**
  - `session-logs` — OpenClaw session JSONL transcripts
  - `search-history` — prior CC conversations
  - Talk-2-Text or voice service monitoring
  - Proper application log aggregation (Grafana/Loki/etc.)

This is strictly ad-hoc runtime stdout capture for the "the dev server did something weird" case.
