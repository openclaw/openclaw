---
summary: "Google Meet live test checklist and fixes for join, speech, creation, and Twilio failures"
read_when:
  - You are checking a Google Meet setup before an unattended agent joins
  - An agent joined a Meet call but cannot see, hear, or talk
  - A Twilio dial-in leg never enters the Meet room
title: "Google Meet troubleshooting"
sidebarTitle: "Troubleshooting"
---

The pre-flight live test checklist and fixes for join, speech, creation, and Twilio failures. Part of the [Google Meet plugin](/plugins/google-meet) guide.

## Live test checklist

Before handing a meeting to an unattended agent:

```bash
openclaw googlemeet setup
openclaw nodes status
openclaw googlemeet test-speech https://meet.google.com/abc-defg-hij \
  --transport chrome-node \
  --message "Say exactly: Google Meet speech test complete."
```

Expected Chrome-node state:

- `googlemeet setup` is all green, and includes `chrome-node-connected` when Chrome-node is the default transport or a node is pinned.
- `nodes status` shows the selected node connected, advertising both `googlemeet.chrome` and `browser.proxy`.
- The Meet tab joins, and `test-speech` returns Chrome health with `inCall: true`.

For a remote Chrome host such as a Parallels macOS VM, the shortest safe check after updating the Gateway or the VM:

```bash
openclaw googlemeet setup
openclaw nodes status --connected
openclaw nodes invoke \
  --node parallels-macos \
  --command googlemeet.chrome \
  --params '{"action":"setup"}'
```

That proves the Gateway plugin is loaded, the VM node is connected with the current token, and the Meet audio bridge is available before an agent opens a real meeting tab.

For a Twilio smoke, use a meeting that exposes phone dial-in details:

```bash
openclaw googlemeet setup
openclaw googlemeet join https://meet.google.com/abc-defg-hij \
  --transport twilio \
  --dial-in-number +15551234567 \
  --pin 123456
```

Expected Twilio state:

- `googlemeet setup` includes green `twilio-voice-call-plugin`, `twilio-voice-call-credentials`, and `twilio-voice-call-webhook` checks.
- `voicecall` is available in the CLI after Gateway reload.
- The returned session has `transport: "twilio"` and a `twilio.voiceCallId`.
- `openclaw logs --follow` shows DTMF TwiML served before realtime TwiML, then a realtime bridge with the initial greeting queued.
- `googlemeet leave <sessionId>` hangs up the delegated voice call.

## Troubleshooting

### Agent cannot see the Google Meet tool

Confirm the plugin is enabled and reload the Gateway; the running agent only sees plugin tools registered by the current Gateway process:

```bash
openclaw plugins list | grep google-meet
openclaw googlemeet setup
```

On Linux, local Chrome talk-back requires PipeWire-Pulse in the Chrome desktop user's session plus `pactl`, `pacat`, and `parec`. On unsupported operating systems, use `mode: "transcribe"`, Twilio dial-in, or a supported macOS/Linux `chrome-node` host.

### No connected Google Meet-capable node

On the node host:

```bash
openclaw plugins install npm:@openclaw/google-meet
openclaw plugins enable browser
OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 \
  openclaw node run --host <gateway-lan-ip> --port 18789 --display-name parallels-macos
```

On the Gateway host:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw nodes status
```

The node must be connected and list `googlemeet.chrome` plus `browser.proxy`; the Gateway config must allow both:

```json5
{
  gateway: {
    nodes: {
      commands: { allow: ["browser.proxy", "googlemeet.chrome"] },
    },
  },
}
```

If `googlemeet setup` fails `chrome-node-connected`, or the Gateway log reports `gateway token mismatch`, reinstall or restart the node with the current Gateway token:

```bash
OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 \
  openclaw node install \
  --host <gateway-lan-ip> \
  --port 18789 \
  --display-name parallels-macos \
  --force
```

Then reload the node service and re-run:

```bash
openclaw googlemeet setup
openclaw nodes status --connected
```

### Browser opens but agent cannot join

Run `googlemeet test-listen` for observe-only joins or `googlemeet test-speech` for realtime joins, then inspect the returned Chrome health. If either includes `manualAction`, show `manualAction.message` to the operator and stop retrying until the browser action is complete.

Common manual actions: sign in to the Chrome profile; admit the guest from the Meet host account; grant Chrome microphone/camera permissions when the native prompt appears; close or repair a stuck Meet permission dialog.

Do not report "not signed in" just because Meet asks "Do you want people to hear you in the meeting?"; that is Meet's audio-choice interstitial. OpenClaw clicks **Use microphone** through browser automation when available and keeps waiting for the real meeting state; for create-only browser fallback it may click **Continue without microphone** instead, since minting the URL does not need the realtime audio path.

### Meeting creation fails

`googlemeet create` uses the Meet API `spaces.create` when OAuth is configured, otherwise the pinned Chrome node browser. Confirm:

- **API creation**: `oauth.clientId` and `oauth.refreshToken` (or matching `OPENCLAW_GOOGLE_MEET_*` env vars) are present, and the refresh token was minted after create support was added; older tokens may lack `meetings.space.created`, so rerun `openclaw googlemeet auth login --json`.
- **Browser fallback**: `defaultTransport: "chrome-node"` and `chromeNode.node` point at a connected node with `browser.proxy` and `googlemeet.chrome`; the OpenClaw Chrome profile on that node is signed in and can open `https://meet.google.com/new`.
- **Browser fallback retries**: reuse an existing `.../new` or Google account prompt tab before opening a new one; retry the tool call rather than manually opening another tab.
- **Manual action**: if the tool returns `manualAction`, use `browser.nodeId`, `browser.targetId`, `browserUrl`, and `manualAction.message` to guide the operator; do not retry in a loop.
- **Audio-choice interstitial**: if Meet shows "Do you want people to hear you in the meeting?", leave the tab open. OpenClaw should click **Use microphone** or (create-only) **Continue without microphone** and keep waiting for the generated URL; if it cannot, the error should mention `meet-audio-choice-required`, not `google-login-required`.

### Agent joins but does not talk

```bash
openclaw googlemeet setup
openclaw googlemeet doctor
```

Use `mode: "agent"` for the STT -> OpenClaw agent -> TTS path, `mode: "bidi"` for the direct realtime voice fallback. `mode: "transcribe"` intentionally starts no talk-back bridge. For observe-only debugging, run `openclaw googlemeet status --json <session-id>` after participants speak and check `captioning`, `transcriptLines`, `lastCaptionText`. If `inCall` is true but `transcriptLines` stays `0`, Meet captions may be disabled, no one has spoken since the observer was installed, the Meet UI changed, or live captions are unavailable for the meeting language/account.

`googlemeet test-speech` always checks the realtime path and reports whether bridge output bytes were observed for that invocation. If `speechOutputVerified` is false and `speechOutputTimedOut` is true, the realtime provider may have accepted the utterance but OpenClaw did not see new output bytes reach the Chrome audio bridge.

Also verify: a realtime provider key (`OPENAI_API_KEY` or `GEMINI_API_KEY`) is available on the Gateway host; the native audio backend is ready on the Chrome host; and Meet mic/speaker are routed through the virtual audio path (`doctor` should show both input and output routed for local Chrome realtime joins).

`googlemeet doctor [session-id]` prints session, node, in-call state, manual action reason, realtime provider connection, `realtimeReady`, audio input/output activity, last audio timestamps, byte counters, and browser URL. Use `googlemeet status [session-id] --json` for raw JSON, and `googlemeet doctor --oauth` (add `--meeting` or `--create-space`) to verify OAuth refresh without exposing tokens.

If an agent timed out and a Meet tab is already open, inspect it without opening another one:

```bash
openclaw googlemeet recover-tab
openclaw googlemeet recover-tab https://meet.google.com/abc-defg-hij
```

The equivalent tool action is `recover_current_tab`: it focuses and inspects an existing Meet tab for the selected transport (local browser control for `chrome`, the configured node for `chrome-node`) without opening a new tab or session, and reports the current blocker (login, admission, permissions, audio-choice state). The CLI command talks to the configured Gateway, which must be running; `chrome-node` also requires the node to be connected.

### Twilio setup checks fail

`twilio-voice-call-plugin` fails when `voice-call` is not allowed or not enabled: add it to `plugins.allow`, enable `plugins.entries.voice-call`, reload the Gateway.

`twilio-voice-call-credentials` fails when the Twilio backend is missing account SID, auth token, or caller number:

```bash
export TWILIO_ACCOUNT_SID=AC...
export TWILIO_AUTH_TOKEN=...
export TWILIO_FROM_NUMBER=+15550001234
```

`twilio-voice-call-webhook` fails when `voice-call` has no public webhook exposure, or `publicUrl` points at loopback/private network space. Do not use `localhost`, `127.0.0.1`, `0.0.0.0`, `10.x`, `172.16.x`-`172.31.x`, `192.168.x`, `169.254.x`, `fc00::/7`, or `fd00::/8` as `publicUrl`; carrier callbacks cannot reach those. Set `plugins.entries.voice-call.config.publicUrl` to a public URL, or configure a tunnel/Tailscale exposure:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio",
          fromNumber: "+15550001234",
          publicUrl: "https://voice.example.com/voice/webhook",
        },
      },
    },
  },
}
```

For local development, use a tunnel or Tailscale exposure instead of a private host URL:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tunnel: { provider: "ngrok" },
          // or
          tailscale: { mode: "funnel", path: "/voice/webhook" },
        },
      },
    },
  },
}
```

Restart or reload the Gateway, then:

```bash
openclaw googlemeet setup --transport twilio
openclaw voicecall setup
openclaw voicecall smoke
```

`voicecall smoke` is readiness-only by default. Dry-run a specific number:

```bash
openclaw voicecall smoke --to "+15555550123"
```

Only add `--yes` to intentionally place a live outbound call:

```bash
openclaw voicecall smoke --to "+15555550123" --yes
```

### Twilio call starts but never enters the meeting

Confirm the Meet event exposes phone dial-in details, and pass the exact dial-in number plus PIN or a custom DTMF sequence:

```bash
openclaw googlemeet join https://meet.google.com/abc-defg-hij \
  --transport twilio \
  --dial-in-number +15551234567 \
  --dtmf-sequence ww123456#
```

Use leading `w` or commas in `--dtmf-sequence` for a pause before the PIN.

If the call is created but the Meet roster never shows the dial-in participant:

- `openclaw googlemeet doctor <session-id>`: confirm the delegated Twilio call ID, whether DTMF was queued, and whether the intro greeting was requested.
- `openclaw voicecall status --call-id <id>`: confirm the call is still active.
- `openclaw voicecall tail`: confirm Twilio webhooks are arriving at the Gateway.
- `openclaw logs --follow`: look for the Twilio Meet sequence: Google Meet delegates the join, Voice Call stores and serves pre-connect DTMF TwiML, Voice Call serves realtime TwiML for the Twilio call, then Google Meet requests intro speech with `voicecall.speak`.
- Re-run `openclaw googlemeet setup --transport twilio`; a green setup check is required but does not prove the meeting PIN sequence is correct.
- Confirm the dial-in number belongs to the same Meet invitation and region as the PIN.
- Increase `voiceCall.dtmfDelayMs` from the 12-second default if Meet answers slowly or the call transcript still shows the PIN prompt after pre-connect DTMF was sent.
- If the participant joins but you do not hear the greeting, check `openclaw logs --follow` for the post-DTMF `voicecall.speak` request and either media-stream TTS playback or the Twilio `<Say>` fallback. If the transcript still shows "enter the meeting PIN", the phone leg has not joined the Meet room yet, so participants will not hear speech.

If webhooks do not arrive, debug the Voice Call plugin first: the provider must reach `plugins.entries.voice-call.config.publicUrl` or the configured tunnel. See [Voice call troubleshooting](/plugins/voice-call#troubleshooting).
