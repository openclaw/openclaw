# Herdr State Bridge

This bundled extension documents the OpenClaw TUI to Herdr pane-state bridge.
The runtime sidecar lives in `src/tui/herdr-state-sidecar.ts` because the TUI
process is the process that inherits `HERDR_PANE_ID` from Herdr.

When `openclaw tui` starts and `HERDR_PANE_ID` is set, OpenClaw starts an
in-process sidecar that reads the visible Herdr pane and reports:

- `gateway connected | idle` as `idle`
- Braille spinner plus `| connected` as `working`
- approval modal text such as `Approve this command?` as `blocked`

Set `OPENCLAW_HERDR_STATE_DISABLE=1` to disable the bridge. Set
`OPENCLAW_HERDR_STATE_INTERVAL_MS=500` to adjust the polling interval. The
default is `1000`; values below `250` are clamped.

## Smoke Test

```bash
herdr server
herdr pane send-text <pane_id> "clear; openclaw tui"
herdr pane send-keys <pane_id> Enter
herdr pane send-text <pane_id> "Hello"
herdr pane send-keys <pane_id> Enter

herdr pane get <pane_id> | python3 -c "import json,sys; r=json.load(sys.stdin)['result']['pane']; print(r.get('agent'), r.get('agent_status'), r.get('custom_status'))"
```

Expected transition while the TUI is answering:

```text
openclaw working 1s
openclaw working 2s
openclaw idle
```

Close the pane, then verify no OpenClaw process remains alive only because of
the Herdr state bridge.
