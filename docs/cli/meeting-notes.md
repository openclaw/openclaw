---
summary: "CLI reference for `openclaw meeting-notes` (list, show, and locate stored meeting notes)"
read_when:
  - You want to read stored meeting note summaries from the terminal
  - You need the path to a meeting notes markdown summary
  - You are debugging the meeting-notes plugin storage layout
title: "Meeting Notes CLI"
---

# `openclaw meeting-notes`

Inspect meeting notes written by the bundled `meeting-notes` plugin. This CLI is
read-only: capture, import, and summarization are owned by the `meeting_notes`
agent tool and by configured auto-start sources.

Artifacts live under the OpenClaw state directory:

```text
$OPENCLAW_STATE_DIR/meeting-notes/<session>/
  metadata.json
  transcript.jsonl
  summary.json
  summary.md
```

The default state directory is `~/.openclaw`; set `OPENCLAW_STATE_DIR` to use a
different one.

## Commands

```bash
openclaw meeting-notes list
openclaw meeting-notes show <session>
openclaw meeting-notes path <session>
openclaw meeting-notes path <session> --dir
openclaw meeting-notes path <session> --transcript
openclaw meeting-notes list --json
openclaw meeting-notes show <session> --json
```

- `list`: list stored sessions, start time, title, and `summary.md` path.
- `show <session>`: print the stored `summary.md`.
- `path <session>`: print the `summary.md` path.
- `path <session> --dir`: print the session directory.
- `path <session> --metadata`: print `metadata.json`.
- `path <session> --transcript`: print `transcript.jsonl`.
- `--json`: print machine-readable output.

See [Meeting Notes](/plugins/meeting-notes) for configuration, auto-start, and
source-provider details.
