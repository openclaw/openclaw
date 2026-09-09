---
summary: "Google Meet plugin: join explicit Meet URLs through Chrome or Twilio with agent talk-back defaults"
read_when:
  - You want an OpenClaw agent to join a Google Meet call
  - You want an OpenClaw agent to create a new Google Meet call
  - You are configuring Chrome, Chrome node, or Twilio as a Google Meet transport
title: "Google Meet plugin"
---

The `google-meet` plugin joins explicit Meet URLs on behalf of an OpenClaw agent. It is deliberately narrow:

- It only joins `https://meet.google.com/...` URLs; it never dials into a meeting from a phone number it discovers itself.
- `googlemeet create` can mint a new Meet URL through the Google Meet API (or a browser fallback) and join it by default.
- Chrome participation uses a signed-in Chrome profile, optionally on a paired node. Twilio participation dials a phone number plus PIN/DTMF through the [Voice call plugin](/plugins/voice-call); it cannot dial a Meet URL directly.
- `mode: "agent"` (default) transcribes participant speech with a realtime provider, routes it to the configured OpenClaw agent, and speaks the answer with regular OpenClaw TTS. `mode: "bidi"` lets a realtime voice model answer directly. `mode: "transcribe"` joins observe-only with no talk-back.
- There is no automatic consent announcement when the plugin joins a call.
- The CLI command is `googlemeet`; `meet` is reserved for broader agent teleconference workflows.

## Quick start

Install the plugin and the native audio dependencies for the Chrome host, then set a realtime provider key. OpenAI is the default transcription provider for `agent` mode; Google Gemini Live is available as the `bidi`-mode voice provider. On macOS:

```bash
openclaw plugins install npm:@openclaw/google-meet
brew install blackhole-2ch sox
export OPENAI_API_KEY=sk-...
# only needed when realtime.voiceProvider is "google" for bidi mode
export GEMINI_API_KEY=...
```

`blackhole-2ch` installs the `BlackHole 2ch` virtual audio device Chrome routes through. Homebrew's installer requires a reboot before macOS exposes the device:

```bash
sudo reboot
```

After reboot, verify both pieces:

```bash
system_profiler SPAudioDataType | grep -i BlackHole
command -v sox
```

On a Linux desktop with PipeWire-Pulse:

```bash
sudo apt install pipewire-audio pulseaudio-utils # Debian/Ubuntu
systemctl --user --now enable pipewire pipewire-pulse wireplumber
pactl info
command -v pactl pacat parec
```

OpenClaw provisions an `OpenClaw Meeting Audio` null sink and matching source in that desktop user's audio session. Run the Gateway or paired node as the same user that runs Chrome.

The plugin is enabled by default after installation. Add an entry only to customize it:

```json5
{
  plugins: {
    entries: {
      "google-meet": {
        config: {},
      },
    },
  },
}
```

Run `openclaw plugins disable google-meet` if you do not want the plugin active.

Check setup, then join:

```bash
openclaw googlemeet setup
openclaw googlemeet join https://meet.google.com/abc-defg-hij
```

`setup` output is agent-readable and mode/transport-aware: it reports Chrome profile, node pinning, and, for realtime Chrome joins, the native virtual-audio backend and delayed-intro check. Observe-only joins skip realtime prerequisites:

```bash
openclaw googlemeet setup --transport chrome-node --mode transcribe
```

When Twilio delegation is configured, `setup` also reports whether `voice-call`, Twilio credentials, and public webhook exposure are ready. Treat any `ok: false` check as a blocker for that transport/mode before an agent joins. Use `--json` for machine-readable output, and `--transport chrome|chrome-node|twilio` to preflight a specific transport ahead of time:

```bash
openclaw googlemeet setup --transport twilio
```

Or let an agent join through the `google_meet` tool:

```json
{
  "action": "join",
  "url": "https://meet.google.com/abc-defg-hij",
  "transport": "chrome-node",
  "mode": "agent"
}
```

Local Chrome talk-back supports macOS with `BlackHole 2ch` and SoX, or Linux with PipeWire-Pulse and `pactl`/`pacat`/`parec`. On other operating systems, use `mode: "transcribe"`, Twilio dial-in, or a supported macOS/Linux `chrome-node` host.

### Create a meeting

```bash
openclaw googlemeet create --transport chrome-node --mode agent
openclaw googlemeet create --no-join
```

`create` has two paths, reported in the result's `source` field:

- **`api`**: used when Google Meet OAuth credentials are configured. Deterministic; does not depend on browser UI state.
- **`browser`**: used without OAuth credentials. OpenClaw opens `https://meet.google.com/new` on the pinned Chrome node and waits for Google to redirect to a real meeting-code URL; the OpenClaw Chrome profile on that node must already be signed in to Google. Join and create both reuse an existing Meet tab (or an in-progress `.../new` / Google account prompt tab) before opening a new one; tab matching ignores harmless query strings like `authuser`.

`create` joins by default and returns `joined: true` plus the join session. Pass `--no-join` (CLI) or `"join": false` (tool) to mint the URL only.

For API-created rooms, set an explicit access policy instead of inheriting the Google account default:

```bash
openclaw googlemeet create --access-type OPEN --transport chrome-node --mode agent
```

| `--access-type` | Who can join without knocking                                       |
| --------------- | ------------------------------------------------------------------- |
| `OPEN`          | Anyone with the Meet URL                                            |
| `TRUSTED`       | Host org's trusted users, invited external users, and dial-in users |
| `RESTRICTED`    | Invitees only                                                       |

This only applies to API-created rooms, so OAuth must be configured. If you authenticated before this option existed, rerun `openclaw googlemeet auth login --json` after adding the `meetings.space.settings` scope to your OAuth consent screen.

If the browser fallback hits a Google login or Meet permission blocker, the tool returns `manualAction: { reason, message }` with the `browser.nodeId`/`browser.targetId`/`browserUrl`. Report that message and stop opening new Meet tabs until the operator finishes the browser step.

### Observe-only join

Set `"mode": "transcribe"` to skip the duplex realtime bridge (no virtual-audio requirement, no talk-back). Transcribe-mode Chrome joins also skip OpenClaw's microphone/camera permission grant and the Meet **Use microphone** path; if Meet shows the audio-choice interstitial, automation tries **Continue without microphone** first. Managed Chrome transports install a best-effort Meet caption observer in every mode so durable notes are available without changing the live agent-consult path. `googlemeet status --json` and `googlemeet doctor` report `captioning`, `captionsEnabledAttempted`, `transcriptLines`, `lastCaptionAt`, `lastCaptionSpeaker`, `lastCaptionText`, and a `recentTranscript` tail.

For the bounded session transcript, read the exact tracked Meet tab:

```bash
openclaw googlemeet transcript <session-id>
openclaw googlemeet transcript <session-id> --since <next-index> --json
```

The observer keeps at most 2,000 completed caption lines in the Meet page. Visible progressive text stays in the status health tail until the caption row completes, so saving `nextIndex` cannot skip a later text expansion; leaving finalizes visible rows before the snapshot. `droppedLines` reports lines lost from the head when the cap is exceeded. The bounded `googlemeet transcript` tail still keeps only the four most recently ended sessions and resets with the Gateway. Separately, OpenClaw appends completed caption rows to the shared state database throughout the meeting and writes a derived summary on leave. Use [`openclaw transcripts`](/cli/transcripts) to inspect or export those durable notes.

Automatic notes are enabled by default. Set `transcripts.enabled: false` to
disable durable notes globally; explicit `transcribe` mode still exposes only
its bounded live tail. Twilio joins do not have the browser caption stream and
are not captured by this path.

For a yes/no listen probe:

```bash
openclaw googlemeet test-listen <meet-url> --transport chrome-node
```

It joins in transcribe mode, waits for fresh caption/transcript movement, and returns `listenVerified`, `listenTimedOut`, manual-action fields, and current caption health.

### Realtime session health

During talk-back sessions, `google_meet` status reports Chrome/audio bridge health: `inCall`, `manualAction`, `providerConnected`, `realtimeReady`, `audioInputActive`, `audioOutputActive`, last input/output timestamps, byte counters, and bridge-closed state. Managed Chrome sessions only speak the intro/test phrase after health reports `inCall: true`; otherwise `speechReady: false` and the speech attempt is blocked rather than silently no-opping.

Local Chrome joins through the signed-in OpenClaw browser profile and routes its microphone and speaker through the native backend selected by `chrome.audioBackend`. The default shared loopback device is enough for a first smoke test but can echo; use separate virtual devices or a Loopback-style graph for clean duplex audio.

## Notes

Google Meet's official media API is receive-oriented, so speaking into a call still needs a participant path. This plugin keeps that boundary visible: Chrome handles browser participation and local audio routing; Twilio handles phone dial-in participation.

Chrome talk-back modes need a supported native virtual-audio backend plus either:

- `chrome.audioInputCommand` plus `chrome.audioOutputCommand`: OpenClaw owns the bridge and pipes audio in `chrome.audioFormat` between those commands and the selected provider. `agent` mode uses realtime transcription plus regular TTS; `bidi` mode uses the realtime voice provider. The default path is 24 kHz PCM16 with `chrome.audioBufferBytes: 4096`; 8 kHz G.711 mu-law remains available for legacy command pairs.
- `chrome.audioBridgeCommand`: an external bridge command owns the whole local audio path and must exit after starting or validating its daemon. Valid only for `bidi`, because `agent` mode needs direct command-pair access for TTS.

With the command-pair Chrome bridge, `chrome.bargeInInputCommand` can listen to a separate local microphone and clear assistant playback when a human starts talking, keeping human speech ahead of assistant output even while the shared virtual loopback input is temporarily suppressed during assistant playback. Like `chrome.audioInputCommand`/`chrome.audioOutputCommand`, it is an operator-configured local command: use an explicit trusted command path or argument list, never a script from an untrusted location.

For clean duplex audio, route Meet output and Meet microphone through separate virtual devices or a Loopback-style virtual device graph; the default shared loopback device can echo other participants back into the call.

`googlemeet speak` triggers the active talk-back audio bridge for a Chrome session; `googlemeet leave` stops it (and, for Twilio sessions delegated through Voice Call, hangs up the underlying call). Use `googlemeet end-active-conference` to also close the active Google Meet conference for an API-managed space.

## Where each section moved

Every section of the single-page version now lives on this page or on one of
the five child pages below. The anchors from the single-page version still
resolve here.

### Google Meet transports and hosts

[Google Meet transports and hosts](/plugins/google-meet/transports) — Chrome, Chrome node, and Twilio transports, the Parallels macOS VM topology, and the host audio tools they need.

- <a id="local-gateway-%2B-parallels-chrome"></a><a id="local-gateway-+-parallels-chrome"></a>[Local Gateway + Parallels Chrome](/plugins/google-meet/transports#local-gateway-%2B-parallels-chrome)
- <a id="common-failure-checks"></a>[Common failure checks](/plugins/google-meet/transports#common-failure-checks)
- <a id="install-notes"></a>[Install notes](/plugins/google-meet/transports#install-notes)
- <a id="transports"></a>[Transports](/plugins/google-meet/transports#transports)
- <a id="chrome"></a>[Chrome](/plugins/google-meet/transports#chrome)
- <a id="twilio"></a>[Twilio](/plugins/google-meet/transports#twilio)

### Google Meet OAuth and artifacts

[Google Meet OAuth and artifacts](/plugins/google-meet/oauth-and-artifacts) — Google Cloud credentials, the refresh token, OAuth verification, and reading Meet artifacts, attendance, and exports.

- <a id="oauth-and-preflight"></a>[OAuth and preflight](/plugins/google-meet/oauth-and-artifacts#oauth-and-preflight)
- <a id="create-google-credentials"></a>[Create Google credentials](/plugins/google-meet/oauth-and-artifacts#create-google-credentials)
- <a id="create-or-select-a-project"></a>[Create or select a project](/plugins/google-meet/oauth-and-artifacts#create-or-select-a-project)
- <a id="enable-the-google-meet-rest-api"></a>[Enable the Google Meet REST API](/plugins/google-meet/oauth-and-artifacts#enable-the-google-meet-rest-api)
- <a id="configure-the-oauth-consent-screen"></a>[Configure the OAuth consent screen](/plugins/google-meet/oauth-and-artifacts#configure-the-oauth-consent-screen)
- <a id="add-the-requested-scopes"></a>[Add the requested scopes](/plugins/google-meet/oauth-and-artifacts#add-the-requested-scopes)
- <a id="create-an-oauth-client-id"></a>[Create an OAuth client ID](/plugins/google-meet/oauth-and-artifacts#create-an-oauth-client-id)
- <a id="copy-the-client-id-and-client-secret"></a>[Copy the client ID and client secret](/plugins/google-meet/oauth-and-artifacts#copy-the-client-id-and-client-secret)
- <a id="mint-the-refresh-token"></a>[Mint the refresh token](/plugins/google-meet/oauth-and-artifacts#mint-the-refresh-token)
- <a id="verify-oauth-with-doctor"></a>[Verify OAuth with doctor](/plugins/google-meet/oauth-and-artifacts#verify-oauth-with-doctor)
- <a id="resolve%2C-preflight%2C-and-read-artifacts"></a><a id="resolve-preflight-and-read-artifacts"></a>[Resolve, preflight, and read artifacts](/plugins/google-meet/oauth-and-artifacts#resolve%2C-preflight%2C-and-read-artifacts)
- <a id="live-smoke-test"></a>[Live smoke test](/plugins/google-meet/oauth-and-artifacts#live-smoke-test)
- <a id="create-examples"></a>[Create examples](/plugins/google-meet/oauth-and-artifacts#create-examples)

### Google Meet configuration

[Google Meet configuration](/plugins/google-meet/config) — Plugin config defaults, optional overrides, and the ElevenLabs and Twilio config examples.

- <a id="config"></a>[Config](/plugins/google-meet/config#config)
- <a id="defaults"></a>[Defaults](/plugins/google-meet/config#defaults)
- <a id="optional-overrides"></a>[Optional overrides](/plugins/google-meet/config#optional-overrides)

### Google Meet tool and modes

[Google Meet tool and modes](/plugins/google-meet/tool-and-modes) — Tool actions for agents, session status fields, and the agent and bidi talk-back modes.

- <a id="tool"></a>[Tool](/plugins/google-meet/tool-and-modes#tool)
- <a id="agent-and-bidi-modes"></a>[Agent and bidi modes](/plugins/google-meet/tool-and-modes#agent-and-bidi-modes)

### Google Meet troubleshooting

[Google Meet troubleshooting](/plugins/google-meet/troubleshooting) — The pre-flight live test checklist and fixes for join, speech, creation, and Twilio failures.

- <a id="live-test-checklist"></a>[Live test checklist](/plugins/google-meet/troubleshooting#live-test-checklist)
- <a id="troubleshooting"></a>[Troubleshooting](/plugins/google-meet/troubleshooting#troubleshooting)
- <a id="agent-cannot-see-the-google-meet-tool"></a>[Agent cannot see the Google Meet tool](/plugins/google-meet/troubleshooting#agent-cannot-see-the-google-meet-tool)
- <a id="no-connected-google-meet-capable-node"></a>[No connected Google Meet-capable node](/plugins/google-meet/troubleshooting#no-connected-google-meet-capable-node)
- <a id="browser-opens-but-agent-cannot-join"></a>[Browser opens but agent cannot join](/plugins/google-meet/troubleshooting#browser-opens-but-agent-cannot-join)
- <a id="meeting-creation-fails"></a>[Meeting creation fails](/plugins/google-meet/troubleshooting#meeting-creation-fails)
- <a id="agent-joins-but-does-not-talk"></a>[Agent joins but does not talk](/plugins/google-meet/troubleshooting#agent-joins-but-does-not-talk)
- <a id="twilio-setup-checks-fail"></a>[Twilio setup checks fail](/plugins/google-meet/troubleshooting#twilio-setup-checks-fail)
- <a id="twilio-call-starts-but-never-enters-the-meeting"></a>[Twilio call starts but never enters the meeting](/plugins/google-meet/troubleshooting#twilio-call-starts-but-never-enters-the-meeting)

## Related

- [Meeting plugins overview](/plugins/meeting-plugins)
- [Voice call plugin](/plugins/voice-call)
- [Talk mode](/nodes/talk)
- [Building plugins](/plugins/building-plugins)
