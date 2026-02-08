---
summary: "CLI reference for `openclaw reflect` (local reflections / AAR notes)"
read_when:
  - You want to save an after-action review (AAR) for a task
  - You want to list or view past reflections
title: "reflect"
---

# `openclaw reflect`

Capture quick after-action reflections (AAR notes) and store them locally as JSONL.

Data is stored under the OpenClaw state directory:

- Default: `~/.openclaw/reflections.jsonl`
- Override: `$OPENCLAW_STATE_DIR/reflections.jsonl`

Tip: run `openclaw reflect --help` for the full command surface.

## Add

Interactive prompt to create a reflection.

```bash
openclaw reflect add
```

Outputs the new reflection id (UUID).

## List

List reflections (newest first).

```bash
openclaw reflect list
openclaw reflect list --limit 20
openclaw reflect list --tag onboarding
```

Output format:

- `createdAt  id  title  [tags]`

## Show

Show a reflection by id.

```bash
openclaw reflect show <id>
```

Prints a human-readable view followed by the raw JSON.
