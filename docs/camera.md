---
summary: "Camera capture (iOS node + macOS app) for agent use: photos (jpg) and short video clips (mp4)"
read_when:
  - Adding or modifying camera capture on iOS nodes or macOS
  - Extending agent-accessible MEDIA temp-file workflows
---

# Camera capture (agent)

Clawdis supports **camera capture** for agent workflows:

- **iOS node** (paired via Gateway): capture a **photo** (`jpg`) or **short video clip** (`mp4`, with optional audio) via `node.invoke`.
- **Android node** (paired via Gateway): capture a **photo** (`jpg`) or **short video clip** (`mp4`, with optional audio) via `node.invoke`.
- **macOS app** (local control socket): capture a **photo** (`jpg`) or **short video clip** (`mp4`, with optional audio) via `clawdis-mac`.

All camera access is gated behind **user-controlled settings**.

## iOS node

### User setting (default on)

- iOS Settings tab → **Camera** → **Allow Camera** (`camera.enabled`)
  - Default: **on** (missing key is treated as enabled).
  - When off: `camera.*` commands return `CAMERA_DISABLED`.

### Commands (via Gateway `node.invoke`)

- `camera.snap`
  - Params:
    - `facing`: `front|back` (default: `front`)
    - `maxWidth`: number (optional; default `1600` on the iOS node)
    - `quality`: `0..1` (optional; default `0.9`)
    - `format`: currently `jpg`
  - Response payload:
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`

- `camera.clip`
  - Params:
    - `facing`: `front|back` (default: `front`)
    - `durationMs`: number (default `3000`, clamped to a max)
    - `includeAudio`: boolean (default `true`)
    - `format`: currently `mp4`
  - Response payload:
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### Foreground requirement

Like `screen.*`, the iOS node only allows `camera.*` commands in the **foreground**. Background invocations return `NODE_BACKGROUND_UNAVAILABLE`.

### CLI helper (temp files + MEDIA)

The easiest way to get attachments is via the CLI helper, which writes decoded media to a temp file and prints `MEDIA:<path>`.

Examples:

```bash
clawdis nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
clawdis nodes camera snap --node <id> --facing front
clawdis nodes camera clip --node <id> --duration 3000
clawdis nodes camera clip --node <id> --no-audio
```

Notes:
- `nodes camera snap` defaults to **both** facings to give the agent both views.
- Output files are temporary (in the OS temp directory) unless you build your own wrapper.

## Android node

### User setting (default on)

- Android Settings sheet → **Camera** → **Allow Camera** (`camera.enabled`)
  - Default: **on** (missing key is treated as enabled).
  - When off: `camera.*` commands return `CAMERA_DISABLED`.

### Permissions

- Android requires runtime permissions:
  - `CAMERA` for both `camera.snap` and `camera.clip`.
  - `RECORD_AUDIO` for `camera.clip` when `includeAudio=true`.

If permissions are denied, `camera.*` requests fail with a `*_PERMISSION_REQUIRED` error.

### Foreground requirement

Like `screen.*`, the Android node only allows `camera.*` commands in the **foreground**. Background invocations return `NODE_BACKGROUND_UNAVAILABLE`.

## macOS app

### User setting (default off)

The macOS companion app exposes a checkbox:

- **Settings → Debug → Camera → Allow Camera (agent)** (`clawdis.cameraEnabled`)
  - Default: **off**
  - When off: camera requests return “Camera disabled by user”.

### CLI helper (local control socket)

The `clawdis-mac` helper talks to the running menu bar app over the local control socket.

Examples:

```bash
clawdis-mac camera snap                         # prints MEDIA:<path>
clawdis-mac camera snap --max-width 1280
clawdis-mac camera clip --duration-ms 3000      # prints MEDIA:<path>
clawdis-mac camera clip --no-audio
```

Notes:
- `clawdis-mac camera snap` defaults to `maxWidth=1600` unless overridden.

## Safety + practical limits

- Camera and microphone access trigger the usual OS permission prompts (and require usage strings in Info.plist).
- Video clips are intentionally short to avoid oversized bridge payloads (base64 overhead + WebSocket message limits).
