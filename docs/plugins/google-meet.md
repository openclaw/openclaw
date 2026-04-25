---
summary: "Google Meet plugin: join explicit Meet URLs through Chrome or Twilio with realtime voice defaults"
read_when:
  - You want an OpenClaw agent to join a Google Meet call
  - You want an OpenClaw agent to create a new Google Meet call
  - You are configuring Chrome, Chrome node, or Twilio as a Google Meet transport
title: "Google Meet plugin"
---

Google Meet participant support for OpenClaw — the plugin is explicit by design:

- It only joins an explicit `https://meet.google.com/...` URL.
- It can create a new Meet space through the Google Meet API, then join the
  returned URL.
- `realtime` voice is the default mode.
- Realtime voice can call back into the full OpenClaw agent when deeper
  reasoning or tools are needed.
- Agents choose the join behavior with `mode`: use `realtime` for live
  listen/talk-back, or `transcribe` to join/control the browser without the
  realtime voice bridge.
- Auth starts as personal Google OAuth or an already signed-in Chrome profile.
- There is no automatic consent announcement.
- The default Chrome audio backend is `BlackHole 2ch`.
- Chrome can run locally or on a paired node host.
- Twilio accepts a dial-in number plus optional PIN or DTMF sequence.
- The CLI command is `googlemeet`; `meet` is reserved for broader agent
  teleconference workflows.

## Quick start

Install the local audio dependencies and configure a backend realtime voice
provider. OpenAI is the default; Google Gemini Live also works with
`realtime.provider: "google"`:

```bash
brew install blackhole-2ch sox
export OPENAI_API_KEY=sk-...
# or
export GEMINI_API_KEY=...
```

`blackhole-2ch` installs the `BlackHole 2ch` virtual audio device. Homebrew's
installer requires a reboot before macOS exposes the device:

```bash
sudo reboot
```

After reboot, verify both pieces:

```bash
system_profiler SPAudioDataType | grep -i BlackHole
command -v rec play
```

Enable the plugin:

```json5
{
  plugins: {
    entries: {
      "google-meet": {
        enabled: true,
        config: {},
      },
    },
  },
}
```

Check setup:

```bash
openclaw googlemeet setup
```

The setup output is meant to be agent-readable. It reports Chrome profile,
audio bridge, node pinning, delayed realtime intro, and, when Twilio delegation
is configured, whether the `voice-call` plugin and Twilio credentials are ready.
Treat any `ok: false` check as a blocker before asking an agent to join.
Use `openclaw googlemeet setup --json` for scripts or machine-readable output.

Join a meeting:

```bash
openclaw googlemeet join https://meet.google.com/abc-defg-hij
```

Or let an agent join through the `google_meet` tool:

```json
{
  "action": "join",
  "url": "https://meet.google.com/abc-defg-hij",
  "transport": "chrome-node",
  "mode": "realtime"
}
```

Create a new meeting and join it:

```bash
openclaw googlemeet create --transport chrome-node --mode realtime
```

Create only the URL without joining:

```bash
openclaw googlemeet create --no-join
```

`googlemeet create` has two paths:

- API create: used when Google Meet OAuth credentials are configured. This is
  the most deterministic path and does not depend on browser UI state.
- Browser fallback: used when OAuth credentials are absent. OpenClaw uses the
  pinned Chrome node, opens `https://meet.google.com/new`, waits for Google to
  redirect to a real meeting-code URL, then returns that URL. This path requires
  the OpenClaw Chrome profile on the node to already be signed in to Google.
  Browser automation handles Meet's own first-run microphone prompt; that prompt
  is not treated as a Google login failure.
  Join and create flows also try to reuse an existing Meet tab before opening a
  new one. Matching ignores harmless URL query strings such as `authuser`, so an
  agent retry should focus the already-open meeting instead of creating a second
  Chrome tab.

The command/tool output includes a `source` field (`api` or `browser`) so agents
can explain which path was used. `create` joins the new meeting by default and
returns `joined: true` plus the join session. To only mint the URL, use
`create --no-join` on the CLI or pass `"join": false` to the tool.

Or tell an agent: "Create a Google Meet, join it with realtime voice, and send
me the link." The agent should call `google_meet` with `action: "create"` and
then share the returned `meetingUri`.

```json
{
  "action": "create",
  "transport": "chrome-node",
  "mode": "realtime"
}
```

For an observe-only/browser-control join, set `"mode": "transcribe"`. That does
not start the duplex realtime model bridge, so it will not talk back into the
meeting.

During realtime sessions, `google_meet` status includes browser and audio bridge
health such as `inCall`, `manualActionRequired`, `providerConnected`,
`realtimeReady`, `audioInputActive`, `audioOutputActive`, last input/output
timestamps, byte counters, and bridge closed state. If a safe Meet page prompt
appears, browser automation handles it when it can. Login, host admission, and
browser/OS permission prompts are reported as manual action with a reason and
message for the agent to relay.

Chrome joins as the signed-in Chrome profile. In Meet, pick `BlackHole 2ch` for
the microphone/speaker path used by OpenClaw. For clean duplex audio, use
separate virtual devices or a Loopback-style graph; a single BlackHole device is
enough for a first smoke test but can echo.

### Local Gateway + Parallels Chrome

You do **not** need a full OpenClaw Gateway or model API key inside a macOS VM
just to make the VM own Chrome. Run the Gateway and agent locally, then run a
node host in the VM. Enable the bundled plugin on the VM once so the node
advertises the Chrome command:

What runs where:

- Gateway host: OpenClaw Gateway, agent workspace, model/API keys, realtime
  provider, and the Google Meet plugin config.
- Parallels macOS VM: OpenClaw CLI/node host, Google Chrome, SoX, BlackHole 2ch,
  and a Chrome profile signed in to Google.
- Not needed in the VM: Gateway service, agent config, OpenAI/GPT key, or model
  provider setup.

Install the VM dependencies:

```bash
brew install blackhole-2ch sox
```

Reboot the VM after installing BlackHole so macOS exposes `BlackHole 2ch`:

```bash
sudo reboot
```

After reboot, verify the VM can see the audio device and SoX commands:

```bash
system_profiler SPAudioDataType | grep -i BlackHole
command -v rec play
```

Install or update OpenClaw in the VM, then enable the bundled plugin there:

```bash
openclaw plugins enable google-meet
```

Start the node host in the VM:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name parallels-macos
```

If `<gateway-host>` is a LAN IP and you are not using TLS, the node refuses the
plaintext WebSocket unless you opt in for that trusted private network:

```bash
OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 \
  openclaw node run --host <gateway-lan-ip> --port 18789 --display-name parallels-macos
```

Use the same environment variable when installing the node as a LaunchAgent:

```bash
OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 \
  openclaw node install --host <gateway-lan-ip> --port 18789 --display-name parallels-macos --force
openclaw node restart
```

`OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1` is process environment, not an
`openclaw.json` setting. `openclaw node install` stores it in the LaunchAgent
environment when it is present on the install command.

Approve the node from the Gateway host:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

Confirm the Gateway sees the node and that it advertises both `googlemeet.chrome`
and browser capability/`browser.proxy`:

```bash
openclaw nodes status
```

Route Meet through that node on the Gateway host:

```json5
{
  gateway: {
    nodes: {
      allowCommands: ["googlemeet.chrome", "browser.proxy"],
    },
  },
  plugins: {
    entries: {
      "google-meet": {
        enabled: true,
        config: {
          defaultTransport: "chrome-node",
          chrome: {
            guestName: "OpenClaw Agent",
            autoJoin: true,
            reuseExistingTab: true,
          },
          chromeNode: {
            node: "parallels-macos",
          },
        },
      },
    },
  },
}
```

Now join normally from the Gateway host:

```bash
openclaw googlemeet join https://meet.google.com/abc-defg-hij
```

or ask the agent to use the `google_meet` tool with `transport: "chrome-node"`.

For a one-command smoke test that creates or reuses a session, speaks a known
phrase, and prints session health:

```bash
openclaw googlemeet test-speech https://meet.google.com/abc-defg-hij
```

During join, OpenClaw browser automation fills the guest name, clicks Join/Ask
to join, and accepts Meet's first-run "Use microphone" choice when that prompt
appears. During browser-only meeting creation, it can also continue past the
same prompt without microphone if Meet does not expose the use-microphone button.
If the browser profile is not signed in, Meet is waiting for host
admission, Chrome needs microphone/camera permission, or Meet is stuck on a
prompt automation could not resolve, the join/test-speech result reports
`manualActionRequired: true` with `manualActionReason` and
`manualActionMessage`. Agents should stop retrying the join, report that exact
message plus the current `browserUrl`/`browserTitle`, and retry only after the
manual browser action is complete.

If `chromeNode.node` is omitted, OpenClaw auto-selects only when exactly one
connected node advertises both `googlemeet.chrome` and browser control. If
several capable nodes are connected, set `chromeNode.node` to the node id,
display name, or remote IP.

Common failure checks:

- `No connected Google Meet-capable node`: start `openclaw node run` in the VM,
  approve pairing, and make sure `openclaw plugins enable google-meet` and
  `openclaw plugins enable browser` were run in the VM. Also confirm the
  Gateway host allows both node commands with
  `gateway.nodes.allowCommands: ["googlemeet.chrome", "browser.proxy"]`.
- `BlackHole 2ch audio device not found on the node`: install `blackhole-2ch`
  in the VM and reboot the VM.
- Chrome opens but cannot join: sign in to the browser profile inside the VM, or
  keep `chrome.guestName` set for guest join. Guest auto-join uses OpenClaw
  browser automation through the node browser proxy; make sure the node browser
  config points at the profile you want, for example
  `browser.defaultProfile: "user"` or a named existing-session profile.
- Duplicate Meet tabs: leave `chrome.reuseExistingTab: true` enabled. OpenClaw
  activates an existing tab for the same Meet URL before opening a new one, and
  browser meeting creation reuses an in-progress `https://meet.google.com/new`
  or Google account prompt tab before opening another one.
- No audio: in Meet, route microphone/speaker through the virtual audio device
  path used by OpenClaw; use separate virtual devices or Loopback-style routing
  for clean duplex audio.

## Install notes

The Chrome realtime default uses two external tools:

- `sox`: command-line audio utility. The plugin uses its `rec` and `play`
  commands for the default 8 kHz G.711 mu-law audio bridge.
- `blackhole-2ch`: macOS virtual audio driver. It creates the `BlackHole 2ch`
  audio device that Chrome/Meet can route through.

OpenClaw does not bundle or redistribute either package. The docs ask users to
install them as host dependencies through Homebrew. SoX is licensed as
`LGPL-2.0-only AND GPL-2.0-only`; BlackHole is GPL-3.0. If you build an
installer or appliance that bundles BlackHole with OpenClaw, review BlackHole's
upstream licensing terms or get a separate license from Existential Audio.

## Transports

### Chrome

Chrome transport opens the Meet URL in Google Chrome and joins as the signed-in
Chrome profile. On macOS, the plugin checks for `BlackHole 2ch` before launch.
If configured, it also runs an audio bridge health command and startup command
before opening Chrome. Use `chrome` when Chrome/audio live on the Gateway host;
use `chrome-node` when Chrome/audio live on a paired node such as a Parallels
macOS VM.

```bash
openclaw googlemeet join https://meet.google.com/abc-defg-hij --transport chrome
openclaw googlemeet join https://meet.google.com/abc-defg-hij --transport chrome-node
```

Route Chrome microphone and speaker audio through the local OpenClaw audio
bridge. If `BlackHole 2ch` is not installed, the join fails with a setup error
instead of silently joining without an audio path.

### Twilio

Twilio transport is a strict dial plan delegated to the Voice Call plugin. It
does not parse Meet pages for phone numbers.

Use this when Chrome participation is not available or you want a phone dial-in
fallback. Google Meet must expose a phone dial-in number and PIN for the
meeting; OpenClaw does not discover those from the Meet page.

Enable the Voice Call plugin on the Gateway host, not on the Chrome node:

```json5
{
  plugins: {
    allow: ["google-meet", "voice-call"],
    entries: {
      "google-meet": {
        enabled: true,
        config: {
          defaultTransport: "chrome-node",
          // or set "twilio" if Twilio should be the default
        },
      },
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio",
        },
      },
    },
  },
}
```

Provide Twilio credentials through environment or config. Environment keeps
secrets out of `openclaw.json`:

```bash
export TWILIO_ACCOUNT_SID=AC...
export TWILIO_AUTH_TOKEN=...
export TWILIO_FROM_NUMBER=+15550001234
```

Restart or reload the Gateway after enabling `voice-call`; plugin config changes
do not appear in an already running Gateway process until it reloads.

Then verify:

```bash
openclaw config validate
openclaw plugins list | grep -E 'google-meet|voice-call'
openclaw googlemeet setup
```

When Twilio delegation is wired, `googlemeet setup` includes successful
`twilio-voice-call-plugin` and `twilio-voice-call-credentials` checks.

```bash
openclaw googlemeet join https://meet.google.com/abc-defg-hij \
  --transport twilio \
  --dial-in-number +15551234567 \
  --pin 123456
```

Use `--dtmf-sequence` when the meeting needs a custom sequence:

```bash
openclaw googlemeet join https://meet.google.com/abc-defg-hij \
  --transport twilio \
  --dial-in-number +15551234567 \
  --dtmf-sequence ww123456#
```

## OAuth and preflight

OAuth is optional for creating a Meet link because `googlemeet create` can fall
back to browser automation. Configure OAuth when you want official API create,
space resolution, or Meet Media API preflight checks.

Google Meet API access uses a personal OAuth client first. Configure
`oauth.clientId` and optionally `oauth.clientSecret`, then run:

```bash
openclaw googlemeet auth login --json
```

The command prints an `oauth` config block with a refresh token. It uses PKCE,
localhost callback on `http://localhost:8085/oauth2callback`, and a manual
copy/paste flow with `--manual`.

The OAuth consent includes Meet space creation, Meet space read access, and Meet
conference media read access. If you authenticated before meeting creation
support existed, rerun `openclaw googlemeet auth login --json` so the refresh
token has the `meetings.space.created` scope.

No OAuth credentials are needed for the browser fallback. In that mode, Google
auth comes from the signed-in Chrome profile on the selected node, not from
OpenClaw config.

These environment variables are accepted as fallbacks:

- `OPENCLAW_GOOGLE_MEET_CLIENT_ID` or `GOOGLE_MEET_CLIENT_ID`
- `OPENCLAW_GOOGLE_MEET_CLIENT_SECRET` or `GOOGLE_MEET_CLIENT_SECRET`
- `OPENCLAW_GOOGLE_MEET_REFRESH_TOKEN` or `GOOGLE_MEET_REFRESH_TOKEN`
- `OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN` or `GOOGLE_MEET_ACCESS_TOKEN`
- `OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT` or
  `GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT`
- `OPENCLAW_GOOGLE_MEET_DEFAULT_MEETING` or `GOOGLE_MEET_DEFAULT_MEETING`
- `OPENCLAW_GOOGLE_MEET_PREVIEW_ACK` or `GOOGLE_MEET_PREVIEW_ACK`

Resolve a Meet URL, code, or `spaces/{id}` through `spaces.get`:

```bash
openclaw googlemeet resolve-space --meeting https://meet.google.com/abc-defg-hij
```

Run preflight before media work:

```bash
openclaw googlemeet preflight --meeting https://meet.google.com/abc-defg-hij
```

Create a fresh Meet space:

```bash
openclaw googlemeet create
```

The command prints the new `meeting uri`, source, and join session. With OAuth
credentials it uses the official Google Meet API. Without OAuth credentials it
uses the pinned Chrome node's signed-in browser profile as a fallback. Agents can
use the `google_meet` tool with `action: "create"` to create and join in one
step. For URL-only creation, pass `"join": false`.

Example JSON output from the browser fallback:

```json
{
  "source": "browser",
  "meetingUri": "https://meet.google.com/abc-defg-hij",
  "joined": true,
  "browser": {
    "nodeId": "ba0f4e4bc...",
    "targetId": "tab-1"
  },
  "join": {
    "session": {
      "id": "meet_...",
      "url": "https://meet.google.com/abc-defg-hij"
    }
  }
}
```

Example JSON output from API create:

```json
{
  "source": "api",
  "meetingUri": "https://meet.google.com/abc-defg-hij",
  "joined": true,
  "space": {
    "name": "spaces/abc-defg-hij",
    "meetingCode": "abc-defg-hij",
    "meetingUri": "https://meet.google.com/abc-defg-hij"
  },
  "join": {
    "session": {
      "id": "meet_...",
      "url": "https://meet.google.com/abc-defg-hij"
    }
  }
}
```

Creating a Meet joins by default. The Chrome or Chrome-node transport still
needs a signed-in Google Chrome profile to join through the browser. If the
profile is signed out, OpenClaw reports `manualActionRequired: true` or a
browser fallback error and asks the operator to finish Google login before
retrying.

Set `preview.enrollmentAcknowledged: true` only after confirming your Cloud
project, OAuth principal, and meeting participants are enrolled in the Google
Workspace Developer Preview Program for Meet media APIs.

## Config

The common Chrome realtime path only needs the plugin enabled, BlackHole, SoX,
and a backend realtime voice provider key. OpenAI is the default; set
`realtime.provider: "google"` to use Google Gemini Live:

```bash
brew install blackhole-2ch sox
export OPENAI_API_KEY=sk-...
# or
export GEMINI_API_KEY=...
```

Set the plugin config under `plugins.entries.google-meet.config`:

```json5
{
  plugins: {
    entries: {
      "google-meet": {
        enabled: true,
        config: {},
      },
    },
  },
}
```

Defaults:

- `defaultTransport: "chrome"`
- `defaultMode: "realtime"`
- `chromeNode.node`: optional node id/name/IP for `chrome-node`
- `chrome.audioBackend: "blackhole-2ch"`
- `chrome.guestName: "OpenClaw Agent"`: name used on the signed-out Meet guest
  screen
- `chrome.autoJoin: true`: best-effort guest-name fill and Join Now click
  through OpenClaw browser automation on `chrome-node`
- `chrome.reuseExistingTab: true`: activate an existing Meet tab instead of
  opening duplicates
- `chrome.waitForInCallMs: 20000`: wait for the Meet tab to report in-call
  before the realtime intro is triggered
- `chrome.audioInputCommand`: SoX `rec` command writing 8 kHz G.711 mu-law
  audio to stdout
- `chrome.audioOutputCommand`: SoX `play` command reading 8 kHz G.711 mu-law
  audio from stdin
- `realtime.provider: "openai"`
- `realtime.toolPolicy: "safe-read-only"`
- `realtime.instructions`: brief spoken replies, with
  `openclaw_agent_consult` for deeper answers
- `realtime.introMessage`: short spoken readiness check when the realtime bridge
  connects; set it to `""` to join silently

Optional overrides:

```json5
{
  defaults: {
    meeting: "https://meet.google.com/abc-defg-hij",
  },
  chrome: {
    browserProfile: "Default",
    guestName: "OpenClaw Agent",
    waitForInCallMs: 30000,
  },
  chromeNode: {
    node: "parallels-macos",
  },
  realtime: {
    provider: "google",
    toolPolicy: "owner",
    introMessage: "Say exactly: I'm here.",
    providers: {
      google: {
        model: "gemini-2.5-flash-native-audio-preview-12-2025",
        voice: "Kore",
      },
    },
  },
}
```

Twilio-only config:

```json5
{
  defaultTransport: "twilio",
  twilio: {
    defaultDialInNumber: "+15551234567",
    defaultPin: "123456",
  },
  voiceCall: {
    gatewayUrl: "ws://127.0.0.1:18789",
  },
}
```

`voiceCall.enabled` defaults to `true`; with Twilio transport it delegates the
actual PSTN call and DTMF to the Voice Call plugin. If `voice-call` is not
enabled, Google Meet can still validate and record the dial plan, but it cannot
place the Twilio call.

## Tool

Agents can use the `google_meet` tool:

```json
{
  "action": "join",
  "url": "https://meet.google.com/abc-defg-hij",
  "transport": "chrome-node",
  "mode": "realtime"
}
```

Use `transport: "chrome"` when Chrome runs on the Gateway host. Use
`transport: "chrome-node"` when Chrome runs on a paired node such as a Parallels
VM. In both cases the realtime model and `openclaw_agent_consult` run on the
Gateway host, so model credentials stay there.

Use `action: "status"` to list active sessions or inspect a session ID. Use
`action: "speak"` with `sessionId` and `message` to make the realtime agent
speak immediately. Use `action: "test_speech"` to create or reuse the session,
trigger a known phrase, and return `inCall` health when the Chrome host can
report it. Use `action: "leave"` to mark a session ended.

`status` includes Chrome health when available:

- `inCall`: Chrome appears to be inside the Meet call
- `micMuted`: best-effort Meet microphone state
- `manualActionRequired` / `manualActionReason` / `manualActionMessage`: the
  browser profile needs manual login, Meet host admission, permissions, or
  browser-control repair before speech can work
- `providerConnected` / `realtimeReady`: realtime voice bridge state
- `lastInputAt` / `lastOutputAt`: last audio seen from or sent to the bridge

```json
{
  "action": "speak",
  "sessionId": "meet_...",
  "message": "Say exactly: I'm here and listening."
}
```

## Realtime agent consult

Chrome realtime mode is optimized for a live voice loop. The realtime voice
provider hears the meeting audio and speaks through the configured audio bridge.
When the realtime model needs deeper reasoning, current information, or normal
OpenClaw tools, it can call `openclaw_agent_consult`.

The consult tool runs the regular OpenClaw agent behind the scenes with recent
meeting transcript context and returns a concise spoken answer to the realtime
voice session. The voice model can then speak that answer back into the meeting.
It uses the same shared realtime consult tool as Voice Call.

`realtime.toolPolicy` controls the consult run:

- `safe-read-only`: expose the consult tool and limit the regular agent to
  `read`, `web_search`, `web_fetch`, `x_search`, `memory_search`, and
  `memory_get`.
- `owner`: expose the consult tool and let the regular agent use the normal
  agent tool policy.
- `none`: do not expose the consult tool to the realtime voice model.

The consult session key is scoped per Meet session, so follow-up consult calls
can reuse prior consult context during the same meeting.

To force a spoken readiness check after Chrome has fully joined the call:

```bash
openclaw googlemeet speak meet_... "Say exactly: I'm here and listening."
```

For the full join-and-speak smoke:

```bash
openclaw googlemeet test-speech https://meet.google.com/abc-defg-hij \
  --transport chrome-node \
  --message "Say exactly: I'm here and listening."
```

## Live test checklist

Use this sequence before handing a meeting to an unattended agent:

```bash
openclaw googlemeet setup
openclaw nodes status
openclaw googlemeet test-speech https://meet.google.com/abc-defg-hij \
  --transport chrome-node \
  --message "Say exactly: Google Meet speech test complete."
```

Expected Chrome-node state:

- `googlemeet setup` is all green.
- `googlemeet setup` includes `chrome-node-connected` when Chrome-node is the
  default transport or a node is pinned.
- `nodes status` shows the selected node connected.
- The selected node advertises both `googlemeet.chrome` and `browser.proxy`.
- The Meet tab joins the call and `test-speech` returns Chrome health with
  `inCall: true`.

For a remote Chrome host such as a Parallels macOS VM, this is the shortest
safe check after updating the Gateway or the VM:

```bash
openclaw googlemeet setup
openclaw nodes status --connected
openclaw nodes invoke \
  --node parallels-macos \
  --command googlemeet.chrome \
  --params '{"action":"setup"}'
```

That proves the Gateway plugin is loaded, the VM node is connected with the
current token, and the Meet audio bridge is available before an agent opens a
real meeting tab.

For a Twilio smoke, use a meeting that exposes phone dial-in details:

```bash
openclaw googlemeet setup
openclaw googlemeet join https://meet.google.com/abc-defg-hij \
  --transport twilio \
  --dial-in-number +15551234567 \
  --pin 123456
```

Expected Twilio state:

- `googlemeet setup` includes green `twilio-voice-call-plugin` and
  `twilio-voice-call-credentials` checks.
- `voicecall` is available in the CLI after Gateway reload.
- The returned session has `transport: "twilio"` and a `twilio.voiceCallId`.
- `googlemeet leave <sessionId>` hangs up the delegated voice call.

## Troubleshooting

### Agent cannot see the Google Meet tool

Confirm the plugin is enabled in the Gateway config and reload the Gateway:

```bash
openclaw plugins list | grep google-meet
openclaw googlemeet setup
```

If you just edited `plugins.entries.google-meet`, restart or reload the Gateway.
The running agent only sees plugin tools registered by the current Gateway
process.

### No connected Google Meet-capable node

On the node host, run:

```bash
openclaw plugins enable google-meet
openclaw plugins enable browser
OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 \
  openclaw node run --host <gateway-lan-ip> --port 18789 --display-name parallels-macos
```

On the Gateway host, approve the node and verify commands:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw nodes status
```

The node must be connected and list `googlemeet.chrome` plus `browser.proxy`.
The Gateway config must allow those node commands:

```json5
{
  gateway: {
    nodes: {
      allowCommands: ["browser.proxy", "googlemeet.chrome"],
    },
  },
}
```

If `googlemeet setup` fails `chrome-node-connected` or the Gateway log reports
`gateway token mismatch`, reinstall or restart the node with the current Gateway
token. For a LAN Gateway this usually means:

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

Run `googlemeet test-speech` and inspect the returned Chrome health. If it
reports `manualActionRequired: true`, show `manualActionMessage` to the operator
and stop retrying until the browser action is complete.

Common manual actions:

- Sign in to the Chrome profile.
- Admit the guest from the Meet host account.
- Grant Chrome microphone/camera permissions when Chrome's native permission
  prompt appears.
- Close or repair a stuck Meet permission dialog.

Do not report "not signed in" just because Meet shows "Do you want people to
hear you in the meeting?" That is Meet's audio-choice interstitial; OpenClaw
clicks **Use microphone** through browser automation when available and keeps
waiting for the real meeting state. For create-only browser fallback, OpenClaw
may click **Continue without microphone** because creating the URL does not need
the realtime audio path.

### Meeting creation fails

`googlemeet create` first uses the Google Meet API `spaces.create` endpoint
when OAuth credentials are configured. Without OAuth credentials it falls back
to the pinned Chrome node browser. Confirm:

- For API creation: `oauth.clientId` and `oauth.refreshToken` are configured,
  or matching `OPENCLAW_GOOGLE_MEET_*` environment variables are present.
- For API creation: the refresh token was minted after create support was
  added. Older tokens may be missing the `meetings.space.created` scope; rerun
  `openclaw googlemeet auth login --json` and update plugin config.
- For browser fallback: `defaultTransport: "chrome-node"` and
  `chromeNode.node` point at a connected node with `browser.proxy` and
  `googlemeet.chrome`.
- For browser fallback: the OpenClaw Chrome profile on that node is signed in
  to Google and can open `https://meet.google.com/new`.
- For browser fallback: retries reuse an existing `https://meet.google.com/new`
  or Google account prompt tab before opening a new tab. If an agent times out,
  retry the tool call rather than manually opening another Meet tab.
- For browser fallback: if Meet shows "Do you want people to hear you in the
  meeting?", leave the tab open. OpenClaw should click **Use microphone** or, for
  create-only fallback, **Continue without microphone** through browser
  automation and continue waiting for the generated Meet URL. If it cannot, the
  error should mention `meet-audio-choice-required`, not `google-login-required`.

### Agent joins but does not talk

Check the realtime path:

```bash
openclaw googlemeet setup
openclaw googlemeet doctor
```

Use `mode: "realtime"` for listen/talk-back. `mode: "transcribe"` intentionally
does not start the duplex realtime voice bridge.

Also verify:

- A realtime provider key is available on the Gateway host, such as
  `OPENAI_API_KEY` or `GEMINI_API_KEY`.
- `BlackHole 2ch` is visible on the Chrome host.
- `rec` and `play` exist on the Chrome host.
- Meet microphone and speaker are routed through the virtual audio path used by
  OpenClaw.

`googlemeet doctor [session-id]` prints the session, node, in-call state,
manual action reason, realtime provider connection, `realtimeReady`, audio
input/output activity, last audio timestamps, byte counters, and browser URL.
Use `googlemeet status [session-id]` when you need the raw JSON.

If an agent timed out and you can see a Meet tab already open, inspect that tab
without opening another one:

```bash
openclaw googlemeet recover-tab
openclaw googlemeet recover-tab https://meet.google.com/abc-defg-hij
```

The equivalent tool action is `recover_current_tab`. It focuses and inspects an
existing Meet tab on the configured Chrome node. It does not open a new tab or
create a new session; it reports the current blocker, such as login, admission,
permissions, or audio-choice state.

### Twilio setup checks fail

`twilio-voice-call-plugin` fails when `voice-call` is not allowed or not enabled.
Add it to `plugins.allow`, enable `plugins.entries.voice-call`, and reload the
Gateway.

`twilio-voice-call-credentials` fails when the Twilio backend is missing account
SID, auth token, or caller number. Set these on the Gateway host:

```bash
export TWILIO_ACCOUNT_SID=AC...
export TWILIO_AUTH_TOKEN=...
export TWILIO_FROM_NUMBER=+15550001234
```

Then restart or reload the Gateway and run:

```bash
openclaw googlemeet setup
openclaw voicecall setup
openclaw voicecall smoke
```

`voicecall smoke` is readiness-only by default. To dry-run a specific number:

```bash
openclaw voicecall smoke --to "+15555550123"
```

Only add `--yes` when you intentionally want to place a live outbound notify
call:

```bash
openclaw voicecall smoke --to "+15555550123" --yes
```

### Twilio call starts but never enters the meeting

Confirm the Meet event exposes phone dial-in details. Pass the exact dial-in
number and PIN or a custom DTMF sequence:

```bash
openclaw googlemeet join https://meet.google.com/abc-defg-hij \
  --transport twilio \
  --dial-in-number +15551234567 \
  --dtmf-sequence ww123456#
```

Use leading `w` or commas in `--dtmf-sequence` if the provider needs a pause
before entering the PIN.

## Notes

Google Meet's official media API is receive-oriented, so speaking into a Meet
call still needs a participant path. This plugin keeps that boundary visible:
Chrome handles browser participation and local audio routing; Twilio handles
phone dial-in participation.

Chrome realtime mode needs either:

- `chrome.audioInputCommand` plus `chrome.audioOutputCommand`: OpenClaw owns the
  realtime model bridge and pipes 8 kHz G.711 mu-law audio between those
  commands and the selected realtime voice provider.
- `chrome.audioBridgeCommand`: an external bridge command owns the whole local
  audio path and must exit after starting or validating its daemon.

For clean duplex audio, route Meet output and Meet microphone through separate
virtual devices or a Loopback-style virtual device graph. A single shared
BlackHole device can echo other participants back into the call.

`googlemeet speak` triggers the active realtime audio bridge for a Chrome
session. `googlemeet leave` stops that bridge. For Twilio sessions delegated
through the Voice Call plugin, `leave` also hangs up the underlying voice call.

## Related

- [Voice call plugin](/plugins/voice-call)
- [Talk mode](/nodes/talk)
- [Building plugins](/plugins/building-plugins)
