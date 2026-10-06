---
name: tmux
description: "Control tmux sessions/panes for interactive CLIs: list, capture output, send keys, paste text, monitor prompts."
metadata:
  {
    "openclaw":
      {
        "emoji": "🧵",
        "os": ["darwin", "linux"],
        "requires": { "bins": ["tmux"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "tmux",
              "bins": ["tmux"],
              "label": "Install tmux (brew)",
            },
          ],
      },
  }
---

# tmux

Use for existing interactive tmux sessions. For one-shot commands, use normal shell. For new non-interactive background jobs, use background execution.

## Basics

```bash
tmux ls
tmux list-windows -t shared
tmux list-panes -t shared:0
tmux capture-pane -t shared:0.0 -p
tmux capture-pane -t shared:0.0 -p -S -
```

Target format: `session:window.pane`, e.g. `shared:0.0`.

## Send input

Literal text, then Enter:

```bash
tmux send-keys -t shared:0.0 -l -- "Please continue"
tmux send-keys -t shared:0.0 Enter
```

Special keys:

```bash
tmux send-keys -t shared:0.0 C-c
tmux send-keys -t shared:0.0 C-d
tmux send-keys -t shared:0.0 Escape
```

Use `-l --` for arbitrary text. Split text and Enter to avoid paste/newline surprises.

## Sessions

```bash
tmux new-session -d -s worker
tmux rename-session -t old new
tmux kill-session -t worker
```

## Prompt checks

```bash
tmux capture-pane -t worker-3 -p | tail -20
tmux capture-pane -t worker-3 -p | rg "proceed|permission|Yes|No|❯"
```

Approve/select only when the prompt is understood:

```bash
tmux send-keys -t worker-3 -l -- "y"
tmux send-keys -t worker-3 Enter
```

## Helpers

- `scripts/find-sessions.sh`: discover sessions.
- `scripts/wait-for-text.sh`: wait until captured pane contents contain text.

`wait-for-text.sh` searches echoed input and scrollback as well as process output. For command completion, use a unique marker whose full text is split across arguments in the command sent to tmux:

```bash
nonce="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
marker="OPENCLAW_DONE_${nonce}"
tmux send-keys -t shared:0.0 -l -- "sleep 4; printf '%s%s\n' 'OPENCLAW_DONE_' '$nonce'"
tmux send-keys -t shared:0.0 Enter
scripts/wait-for-text.sh -t shared:0.0 -p "$marker" -F -T 30
```

The echoed command never contains the complete marker, and the nonce prevents an older completion line from matching.

## Notes

- `capture-pane -p` prints to stdout for scripts.
- `-S -` captures full scrollback.
- tmux sessions persist across SSH disconnects.
