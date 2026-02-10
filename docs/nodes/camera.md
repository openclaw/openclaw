---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Camera capture (iOS node + macOS app) for agent use: photos (jpg) and short video clips (mp4)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding or modifying camera capture on iOS nodes or macOS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Extending agent-accessible MEDIA temp-file workflows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Camera Capture"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Camera capture (agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw supports **camera capture** for agent workflows:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **iOS node** (paired via Gateway): capture a **photo** (`jpg`) or **short video clip** (`mp4`, with optional audio) via `node.invoke`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Android node** (paired via Gateway): capture a **photo** (`jpg`) or **short video clip** (`mp4`, with optional audio) via `node.invoke`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **macOS app** (node via Gateway): capture a **photo** (`jpg`) or **short video clip** (`mp4`, with optional audio) via `node.invoke`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All camera access is gated behind **user-controlled settings**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## iOS node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### User setting (default on)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iOS Settings tab → **Camera** → **Allow Camera** (`camera.enabled`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Default: **on** (missing key is treated as enabled).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - When off: `camera.*` commands return `CAMERA_DISABLED`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Commands (via Gateway `node.invoke`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `camera.list`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Response payload:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `devices`: array of `{ id, name, position, deviceType }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `camera.snap`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Params:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `facing`: `front|back` (default: `front`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `maxWidth`: number (optional; default `1600` on the iOS node)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `quality`: `0..1` (optional; default `0.9`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `format`: currently `jpg`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `delayMs`: number (optional; default `0`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `deviceId`: string (optional; from `camera.list`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Response payload:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `format: "jpg"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `base64: "<...>"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `width`, `height`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Payload guard: photos are recompressed to keep the base64 payload under 5 MB.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `camera.clip`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Params:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `facing`: `front|back` (default: `front`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `durationMs`: number (default `3000`, clamped to a max of `60000`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `includeAudio`: boolean (default `true`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `format`: currently `mp4`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `deviceId`: string (optional; from `camera.list`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Response payload:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `format: "mp4"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `base64: "<...>"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `durationMs`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `hasAudio`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Foreground requirement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Like `canvas.*`, the iOS node only allows `camera.*` commands in the **foreground**. Background invocations return `NODE_BACKGROUND_UNAVAILABLE`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### CLI helper (temp files + MEDIA)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The easiest way to get attachments is via the CLI helper, which writes decoded media to a temp file and prints `MEDIA:<path>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes camera snap --node <id> --facing front（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes camera clip --node <id> --duration 3000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes camera clip --node <id> --no-audio（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes camera snap` defaults to **both** facings to give the agent both views.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Output files are temporary (in the OS temp directory) unless you build your own wrapper.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Android node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Android user setting (default on)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Android Settings sheet → **Camera** → **Allow Camera** (`camera.enabled`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Default: **on** (missing key is treated as enabled).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - When off: `camera.*` commands return `CAMERA_DISABLED`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Permissions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Android requires runtime permissions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `CAMERA` for both `camera.snap` and `camera.clip`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `RECORD_AUDIO` for `camera.clip` when `includeAudio=true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If permissions are missing, the app will prompt when possible; if denied, `camera.*` requests fail with a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`*_PERMISSION_REQUIRED` error.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Android foreground requirement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Like `canvas.*`, the Android node only allows `camera.*` commands in the **foreground**. Background invocations return `NODE_BACKGROUND_UNAVAILABLE`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Payload guard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Photos are recompressed to keep the base64 payload under 5 MB.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## macOS app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### User setting (default off)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The macOS companion app exposes a checkbox:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Settings → General → Allow Camera** (`openclaw.cameraEnabled`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Default: **off**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - When off: camera requests return “Camera disabled by user”.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### CLI helper (node invoke)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the main `openclaw` CLI to invoke camera commands on the macOS node.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes camera list --node <id>            # list camera ids（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes camera snap --node <id>            # prints MEDIA:<path>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes camera snap --node <id> --max-width 1280（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes camera snap --node <id> --delay-ms 2000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes camera snap --node <id> --device-id <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes camera clip --node <id> --duration 10s          # prints MEDIA:<path>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes camera clip --node <id> --duration-ms 3000      # prints MEDIA:<path> (legacy flag)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes camera clip --node <id> --device-id <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes camera clip --node <id> --no-audio（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw nodes camera snap` defaults to `maxWidth=1600` unless overridden.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On macOS, `camera.snap` waits `delayMs` (default 2000ms) after warm-up/exposure settle before capturing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Photo payloads are recompressed to keep base64 under 5 MB.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Safety + practical limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Camera and microphone access trigger the usual OS permission prompts (and require usage strings in Info.plist).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Video clips are capped (currently `<= 60s`) to avoid oversized node payloads (base64 overhead + message limits).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## macOS screen video (OS-level)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For _screen_ video (not camera), use the macOS companion:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requires macOS **Screen Recording** permission (TCC).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
