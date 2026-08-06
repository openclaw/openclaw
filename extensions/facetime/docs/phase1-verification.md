# FaceTime paired-audio verification

## Proof contract

- Failure: caller audio reached the model through the old BlackHole path, but model speech did not reliably reach the remote caller.
- Changed path: the plugin captures FaceTime and Phone audio through a Core Audio process tap and sends model PCM to `OpenClaw-Feed`, which mirrors into `OpenClaw-Mic`.
- Pass condition: the caller and configured OpenClaw agent hear each other, the remote caller hears the deterministic test phrase, barge-in clears queued speech, the physical Mac speaker stays silent, and all child processes stop after hangup.
- Evidence: focused automated tests, signed Swift helper build, paired-driver loopback preflight, then a user-confirmed iPhone round trip through the plugin.

## Automated proof

```sh
node scripts/run-vitest.mjs extensions/facetime
node scripts/lib/plugin-npm-runtime-build.mjs extensions/facetime
pnpm --dir extensions/facetime build:capture
pnpm --dir extensions/facetime build:helper:macabi
bash -n extensions/facetime/scripts/*.sh
bash extensions/facetime/scripts/test-native.sh
(cd extensions/facetime && npm pack --dry-run)
```

Verify that the package contains no generated `.driver` or native `.build` output.

## Preflight

```sh
openclaw gateway call facetime.preflight --json
```

All required checks must pass. At call time, the native tap first suppresses the call app's hardware playback. The helper then answers with uplink muted without waiting for the Realtime provider. After answer, the plugin connects the provider, verifies that `OpenClaw-Mic` is the active FaceTime or Phone process's only input and that every output is physical, then enables transmission. It continues monitoring the audio owner and both routes. Any post-answer failure immediately suspends model media while retaining the native safety tap, then safety-mutes and retries hangup.

## FaceTime video acceptance

1. Start the gateway and confirm `facetime.status` reports the FaceTime helper connected.
2. Select `OpenClaw-Mic` as FaceTime's microphone and physical speakers or headphones as output.
3. Run preflight.
4. Place the whitelisted iPhone call.
5. Confirm `audioReady`, `realtimeActive`, and `processOutputSuppressed` are true.
6. Run `facetime.testAudio` and confirm the iPhone hears the phrase.
7. Speak from the iPhone and confirm a contextual response.
8. Ask a tool-backed question and confirm agent consultation.
9. Interrupt the agent and confirm queued speech stops promptly.
10. Ask the agent to hang up. Verify the realtime `facetime_end_call` control
    runs without an agent consult, then confirm there is no active call and no
    capture, SoX, or caffeinate child remains.

## FaceTime audio acceptance

Repeat the same sequence with a Phone-owned FaceTime audio call. Select
`OpenClaw-Mic` in Phone, not FaceTime. This is a separate proof because the
live-tested macOS 26.4 route assigns audio-only calls to Phone.

## Evidence classes

- The automated suite and driver loopback are deterministic integration proof.
- A successful process-tap `--check` proves helper execution and TCC permission, but not remote delivery.
- User confirmation from the iPhone is exact-path runtime proof for delivery.
- The predecessor plugin completed user-confirmed FaceTime Audio and video
  round trips on a locally patched OpenClaw `2026.7.2-beta.3` host, including
  caller-name recognition, agent workspace context, tool use, outbound dialing,
  inbound answering, and model-requested hangup.
- The canonical `extensions/facetime` package requires the host authorization
  contract planned for OpenClaw `2026.7.2-beta.8` or later. It needs one
  exact-package live FaceTime Audio pass after that host is published. FaceTime
  video remains a separate acceptance pass.
