---
summary: "Google Meet plugin: join explicit Meet URLs through Chrome or Twilio with realtime voice defaults"
read_when:
  - You want an OpenClaw agent to join a Google Meet call
  - You are configuring Chrome or Twilio as a Google Meet transport
title: "Google Meet Plugin"
---

# Google Meet (plugin)

Google Meet participant support for OpenClaw.

The plugin is explicit by design:

- It only joins an explicit `https://meet.google.com/...` URL.
- `realtime` voice is the default mode.
- Auth starts as personal Google OAuth or an already signed-in Chrome profile.
- There is no automatic consent announcement.
- The default Chrome audio backend is `BlackHole 2ch`.
- Twilio accepts a dial-in number plus optional PIN or DTMF sequence.
- The CLI command is `googlemeet`; `meet` is reserved for broader agent
  teleconference workflows.

## Transports

### Chrome

Chrome transport opens the Meet URL in Google Chrome and joins as the signed-in
Chrome profile. On macOS, the plugin checks for `BlackHole 2ch` before launch.
If configured, it also runs an audio bridge health command and startup command
before opening Chrome.

```bash
openclaw googlemeet join https://meet.google.com/abc-defg-hij --transport chrome
```

Route Chrome microphone and speaker audio through the local OpenClaw audio
bridge. If `BlackHole 2ch` is not installed, the join fails with a setup error
instead of silently joining without an audio path.

### Twilio

Twilio transport is a strict dial plan delegated to the Voice Call plugin. It
does not parse Meet pages for phone numbers.

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

Google Meet Media API access uses a personal OAuth client first. Configure
`oauth.clientId` and optionally `oauth.clientSecret`, then run:

```bash
openclaw googlemeet auth login --json
```

The command prints an `oauth` config block with a refresh token. It uses PKCE,
localhost callback on `http://localhost:8085/oauth2callback`, and a manual
copy/paste flow with `--manual`.

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

Set `preview.enrollmentAcknowledged: true` only after confirming your Cloud
project, OAuth principal, and meeting participants are enrolled in the Google
Workspace Developer Preview Program for Meet media APIs.

## Config

Set config under `plugins.entries.google-meet.config`:

```json5
{
  plugins: {
    entries: {
      "google-meet": {
        enabled: true,
        config: {
          defaultTransport: "chrome",
          defaultMode: "realtime",
          defaults: {
            meeting: "https://meet.google.com/abc-defg-hij",
          },
          preview: {
            enrollmentAcknowledged: false,
          },
          chrome: {
            audioBackend: "blackhole-2ch",
            launch: true,
            browserProfile: "Default",
            // Command-pair bridge: input writes 8 kHz G.711 mu-law audio to stdout.
            audioInputCommand: [
              "rec",
              "-q",
              "-t",
              "raw",
              "-r",
              "8000",
              "-c",
              "1",
              "-e",
              "mu-law",
              "-b",
              "8",
              "-",
            ],
            // Output reads 8 kHz G.711 mu-law audio from stdin.
            audioOutputCommand: [
              "play",
              "-q",
              "-t",
              "raw",
              "-r",
              "8000",
              "-c",
              "1",
              "-e",
              "mu-law",
              "-b",
              "8",
              "-",
            ],
          },
          twilio: {
            defaultDialInNumber: "+15551234567",
            defaultPin: "123456",
          },
          voiceCall: {
            enabled: true,
            gatewayUrl: "ws://127.0.0.1:18789",
            dtmfDelayMs: 2500,
          },
          realtime: {
            provider: "openai",
            model: "gpt-realtime",
            instructions: "You are joining a private Google Meet as Peter's OpenClaw agent. Keep replies brief unless asked.",
            toolPolicy: "safe-read-only",
            providers: {
              openai: {
                apiKey: { env: "OPENAI_API_KEY" },
              },
            },
          },
          auth: {
            provider: "google-oauth",
          },
          oauth: {
            clientId: "your-google-oauth-client-id.apps.googleusercontent.com",
            refreshToken: "stored-refresh-token",
          },
        },
      },
    },
  },
}
```

## Tool

Agents can use the `google_meet` tool:

```json
{
  "action": "join",
  "url": "https://meet.google.com/abc-defg-hij",
  "transport": "chrome",
  "mode": "realtime"
}
```

Use `action: "status"` to list active sessions or inspect a session ID. Use
`action: "leave"` to mark a session ended.

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
