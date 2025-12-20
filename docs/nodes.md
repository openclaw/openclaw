---
summary: "Nodes: pairing, capabilities, permissions, and CLI helpers for canvas/camera/screen/system"
read_when:
  - Pairing iOS/Android nodes to a gateway
  - Using node canvas/camera for agent context
  - Adding new node commands or CLI helpers
---

# Nodes

A **node** is a companion device (iOS/Android today) that connects to the Gateway over the **Bridge** and exposes a command surface (e.g. `canvas.*`, `camera.*`, `system.*`) via `node.invoke`.

macOS can also run in **node mode**: the menubar app connects to the Gateway’s bridge and exposes its local canvas/camera commands as a node (so `clawdis nodes …` works against this Mac).

## Pairing + status

Pairing is gateway-owned and approval-based. See `docs/gateway/pairing.md` for the full flow.

Quick CLI:

```bash
clawdis nodes pending
clawdis nodes approve <requestId>
clawdis nodes reject <requestId>
clawdis nodes status
clawdis nodes describe --node <idOrNameOrIp>
```

## Invoking commands

Low-level (raw RPC):

```bash
clawdis nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

Higher-level helpers exist for the common “give the agent a MEDIA attachment” workflows.

## Screenshots (canvas snapshots)

If the node is showing the Canvas (WebView), `canvas.snapshot` returns `{ format, base64 }`.

CLI helper (writes to a temp file and prints `MEDIA:<path>`):

```bash
clawdis nodes canvas snapshot --node <idOrNameOrIp> --format png
clawdis nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

Simple shortcut (auto-picks a single connected node if possible):

```bash
clawdis canvas snapshot --format png
clawdis canvas snapshot --format jpg --max-width 1200 --quality 0.9
```

## Photos + videos (node camera)

Photos (`jpg`):

```bash
clawdis nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
clawdis nodes camera snap --node <idOrNameOrIp> --facing front
```

Video clips (`mp4`):

```bash
clawdis nodes camera clip --node <idOrNameOrIp> --duration 10s
clawdis nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

Notes:
- The node must be **foregrounded** for `canvas.*` and `camera.*` (background calls return `NODE_BACKGROUND_UNAVAILABLE`).
- Clip duration is clamped (currently `<= 60s`) to avoid oversized base64 payloads.
- Android will prompt for `CAMERA`/`RECORD_AUDIO` permissions when possible; denied permissions fail with `*_PERMISSION_REQUIRED`.

## Screen recordings (nodes)

Nodes expose `screen.record` (mp4). Example:

```bash
clawdis nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
clawdis nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

Notes:
- `screen.record` requires the node app to be foregrounded.
- Android will show the system screen-capture prompt before recording.
- Screen recordings are clamped to `<= 60s`.
- `--no-audio` disables microphone capture (supported on iOS/Android; macOS uses system capture audio).

## System commands (mac node)

The macOS node exposes `system.run` and `system.notify`.

Examples:

```bash
clawdis nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
clawdis nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

Notes:
- `system.run` returns stdout/stderr/exit code in the payload.
- `system.notify` respects notification permission state on the macOS app.

## Permissions map

Nodes may include a `permissions` map in `node.list` / `node.describe`, keyed by permission name (e.g. `screenRecording`, `accessibility`) with boolean values (`true` = granted).

## Mac node mode

- The macOS menubar app connects to the Gateway bridge as a node (so `clawdis nodes …` works against this Mac).
- In remote mode, the app opens an SSH tunnel for the bridge port and connects to `localhost`.

## Where to look in code

- CLI wiring: `src/cli/nodes-cli.ts`
- Canvas snapshot decoding/temp paths: `src/cli/nodes-canvas.ts`
- Duration parsing for CLI: `src/cli/parse-duration.ts`
- iOS node commands: `apps/ios/Sources/Model/NodeAppModel.swift`
- Android node commands: `apps/android/app/src/main/java/com/steipete/clawdis/node/node/*`
