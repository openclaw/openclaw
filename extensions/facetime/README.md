# OpenClaw FaceTime

Operator-assisted FaceTime voice and video bridge for Apple Silicon Macs.

The plugin deliberately does **not** inject code into FaceTime or Phone. Those
apps are Apple platform binaries and reject third-party dylibs under macOS
library validation. Normal users do not need to change SIP, enable developer
tools, install Xcode, or reboot for this plugin.

## Call flow

1. A configured owner places or receives a FaceTime call.
2. The operator answers or confirms it in FaceTime.
3. An authenticated OpenClaw operator grants one-shot approval to
   `attach_current_call`, naming that configured owner handle.
4. `facetime-audio-capture` verifies there is exactly one active Apple-signed
   FaceTime media owner and that the call input is `OpenClaw-Mic`.
5. OpenClaw starts Realtime audio and, when configured, the live visual/OBS
   bridge.

The handle is an operator assertion used for owner authorization; macOS does
not expose a supported out-of-process caller-identity API. The plugin therefore
never auto-answers inbound calls and never claims UI text authenticated a
caller. `end_call` detaches OpenClaw media and reports
`manualHangupRequired: true`; the operator ends the carrier call in FaceTime.

## Components

- `src/audio-pump.ts`: bounded process capture, SoX playback, route proof, and
  child teardown.
- `src/runtime-call-control.ts`: one attached call, media activation, failure
  cleanup, and detach.
- `src/talk-driver.ts`: OpenAI Realtime/other registered realtime provider,
  barge-in, consult tools, and exact PCM clocking.
- `src/video-bridge.ts`: authenticated live-visual surface, OBS scene/source,
  and Virtual Camera lease lifecycle.
- `openclaw/openclaw-facetime`: signed out-of-process capture executable. It no
  longer ships or requires an injected helper dylib.

## Installation

```bash
openclaw plugins install @openclaw/facetime
brew install openclaw/tap/openclaw-facetime
openclaw gateway restart
```

Run `facetime.setup` to inspect the paired audio driver, Screen & System Audio
Recording permission, physical output, realtime provider, and FaceTime process.
Install/update the paired driver only through the explicit admin RPC.

## Optional video

OBS Studio, its Camera Extension, and a registered live-visual provider are
required. Enable OBS WebSocket authentication, set Virtual Camera output to
**Program**, and select **OBS Virtual Camera** once in FaceTime. The bridge owns
only its uniquely named scene/source and only stops a camera lease it started.

## Development

```bash
node scripts/run-vitest.mjs extensions/facetime
sh -n extensions/facetime/scripts/*.sh
(cd extensions/facetime && npm pack --dry-run)
```

Automated validation must not place calls, install drivers, grant permissions,
or touch a live Gateway.
