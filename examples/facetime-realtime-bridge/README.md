# FaceTime Realtime voice bridge

This is a focused macOS proof of the audio path that used to be awkward to build:

```text
caller -> FaceTime -> Core Audio process tap -> OpenAI Realtime
caller <- FaceTime <- OpenClaw-Mic <- OpenClaw-Feed <- OpenAI Realtime
```

The important change is a custom build of BlackHole with two separate Core Audio
devices. The bridge writes model speech to the output-only `OpenClaw-Feed`; the driver
mirrors it internally to the input-only `OpenClaw-Mic` selected in FaceTime. This avoids
the duplex loopback topology that FaceTime Voice Processing suppresses on current macOS.
Caller audio is captured independently from FaceTime's actual audio processes with a
Core Audio process tap, so the model does not hear its own speech.

This example talks directly to an OpenAI Realtime voice model. It does not yet route requests through the full OpenClaw agent. Prove the native FaceTime audio path first, then promote it into a plugin or the signed macOS app.

## Requirements

- macOS 14.4 or later
- FaceTime signed in and running on this Mac
- Xcode
- SoX
- an OpenAI Platform API key with Realtime access
- consent from everyone on the call before capturing or processing call audio

Install SoX with Homebrew:

```sh
brew install sox
```

Build the pinned, SHA-256-verified BlackHole v0.7.1 source and install the paired
OpenClaw driver. Installation prompts for the Mac administrator password and restarts
Core Audio, which disconnects active calls:

```sh
pnpm build:driver
pnpm install:driver
system_profiler SPAudioDataType | grep -E 'OpenClaw-(Mic|Feed)'
```

The driver is ad-hoc signed for local use and installed at
`/Library/Audio/Plug-Ins/HAL/OpenClawBridge.driver`. Its source is the GPL-3.0-licensed
[BlackHole](https://github.com/ExistentialAudio/BlackHole) project; the build script
changes only the factory UUID, bundle identity, device names, visibility, and input/output
capabilities.

### Driver licensing boundary

The bridge example is MIT-licensed OpenClaw code. The generated driver is a separate,
modified GPL-3.0 BlackHole work and is not relicensed under MIT. The driver build output
is gitignored and must not be committed, bundled, or distributed as an OpenClaw artifact.
The pinned source archive contains BlackHole's GPL license and complete source; the build
script records this build's modifications.

These scripts are for a local evaluation build. Anyone distributing the generated driver
must independently satisfy GPL-3.0 source, notice, and modification obligations. BlackHole
also states that non-GPLv3 projects require a separate license from Existential Audio. A
distributable OpenClaw product therefore needs that separate license or a replacement
driver with a compatible license.

## Build and check

From this directory:

```sh
pnpm build:capture
pnpm doctor:openclaw
```

`doctor:openclaw` resolves the existing OpenAI Platform SecretRef from OpenClaw's
talk, voice-call, or model-provider config. The resolved value stays in memory and
is passed only to the bridge child process. It is never printed or placed in a
command-line argument.

The first capture attempt prompts for **Screen & System Audio Recording** permission.
Grant it to the app that launches the bridge, quit that app completely, reopen it,
open FaceTime, and run `pnpm doctor:openclaw` again. The doctor creates and starts a
tap briefly, so a green result proves more than process discovery.

The doctor can verify the paired driver, capture tap, SoX, call process, and API key. It
cannot inspect FaceTime or Phone's app-specific microphone/output overrides through the
public Core Audio default-device API, so it prints that route as a manual check instead of
claiming it passed.

The helper taps `avconferenced`, which owns FaceTime call audio, plus the FaceTime and
Phone app audio processes when Core Audio exposes them. FaceTime video calls use the
FaceTime app; FaceTime audio calls use the Phone app on current macOS. The helper emits
raw signed 16-bit little-endian mono PCM at 24 kHz. Diagnostics go to stderr, so stdout
stays audio-only. Run
`native/.build/release/facetime-audio-capture --list-processes` to inspect the Core
Audio process list.

## Route FaceTime

Use this exact route:

- FaceTime or Phone microphone: `OpenClaw-Mic`
- FaceTime or Phone output: physical Mac speakers or headphones
- bridge output: `OpenClaw-Feed`
- macOS system input: any physical microphone
- macOS system output: the same physical device used by the call app

For a video call, FaceTime owns the call. For an audio call on current macOS, Phone owns
it. In that app's **Video** menu, select `OpenClaw-Mic` directly as the microphone and
select physical speakers or headphones as output.

Do not select a Multi-Output, Aggregate, BlackHole, or `OpenClaw-Feed` device as the call
output. FaceTime's Voice Processing audio unit can reject virtual or aggregate output
pairs, and routing the caller into `OpenClaw-Feed` would create an echo path.

For a headless Mac, keep FaceTime attached to the physical output but mute that output in
Control Center or System Settings. The Core Audio process tap captures caller audio before
hardware mute, so the caller remains available to OpenAI without playing in the room.

Without `--output-device`, the bridge prefers `OpenClaw-Feed`, then falls back to
`BlackHole 2ch` or another installed BlackHole output for legacy experiments.

## Run

First, prove the configured key and selected model can open a live Realtime session:

```sh
pnpm preflight:openclaw
```

Then open or answer a FaceTime call manually, tell the other participant that the AI
bridge is active, and start using the key already configured in OpenClaw:

```sh
pnpm start:openclaw -- --output-device "OpenClaw-Feed"
```

The OpenClaw launcher is intended to run from this repository checkout. To use a
different Platform key without OpenClaw, prompt for it without saving it in shell
history:

```sh
read -s "OPENAI_API_KEY?OpenAI API key: " && export OPENAI_API_KEY
pnpm start -- --output-device "OpenClaw-Feed"
```

The default model is `gpt-realtime-2.1` with the `marin` voice. Override them without editing code:

```sh
OPENAI_REALTIME_MODEL="gpt-realtime-2.1-mini" \
OPENAI_REALTIME_VOICE="cedar" \
pnpm start -- --output-device "OpenClaw-Feed"
```

Press Control-C to stop. The bridge logs final caller and assistant transcripts to stderr for debugging but does not persist them.

## Codex authentication

Codex contains an experimental realtime-conversation path, but its current ChatGPT
OAuth login does not authorize OpenAI Realtime. It still falls back to an OpenAI
Platform API key. This bridge therefore uses the Platform key already configured in
OpenClaw and does not attempt to reuse Codex OAuth credentials.

## Barge-in and limitations

OpenAI server VAD is configured to interrupt an active response when the caller begins speaking. The bridge also restarts the SoX playback process at that moment to discard model audio already queued for the bridge output, then truncates the corresponding Realtime conversation items at the estimated caller-audible sample position. The estimate uses the PCM sample count, preserves network underruns, and includes a conservative 100 ms SoX/CoreAudio latency budget.

- This first proof expects a dedicated AI side of the call. Selecting `OpenClaw-Mic` as FaceTime's microphone replaces the Mac's physical microphone.
- It captures only the selected FaceTime audio processes, not the full system mix.
- It does not initiate, answer, or hang up FaceTime calls.
- A live end-to-end test requires another participant. Unit tests and `pnpm doctor` cannot prove that FaceTime is sending `OpenClaw-Mic` audio to a remote caller.
- Realtime API usage uses OpenAI Platform billing. A ChatGPT subscription does not cover it.

The process-tap setup follows [Apple's Core Audio tap contract](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps)
and the BSD-licensed [AudioCap sample](https://github.com/insidegui/AudioCap), which
documents the otherwise sparse aggregate-device wiring.
