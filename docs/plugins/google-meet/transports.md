---
summary: "Google Meet transports: local Chrome, Chrome on a paired node, and Twilio dial-in"
read_when:
  - You are choosing between local Chrome, a paired Chrome node, and Twilio dial-in
  - You are giving a macOS VM to the Gateway as a Chrome host
  - You are installing the host audio tools the Chrome talk-back path needs
title: "Google Meet transports and hosts"
sidebarTitle: "Transports"
---

Chrome, Chrome node, and Twilio transports, the Parallels macOS VM topology, and the host audio tools they need. Part of the [Google Meet plugin](/plugins/google-meet) guide.

## Local Gateway + Parallels Chrome

A full Gateway or model API key is not required inside a macOS VM just to give it Chrome. Run the Gateway and agent locally; run a node host in the VM.

| Runs where           | What                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Gateway host         | OpenClaw Gateway, agent workspace, model/API keys, realtime provider, Google Meet plugin config |
| Parallels macOS VM   | OpenClaw CLI/node host, Chrome, SoX, BlackHole 2ch, a Chrome profile signed in to Google        |
| Not needed in the VM | Gateway service, agent config, model provider setup                                             |

Install VM dependencies, reboot, verify:

```bash
brew install blackhole-2ch sox
sudo reboot
system_profiler SPAudioDataType | grep -i BlackHole
command -v sox
```

Install the plugin in the VM, where it is enabled by default, and start the node host:

```bash
openclaw plugins install npm:@openclaw/google-meet
openclaw node run --host <gateway-host> --port 18789 --display-name parallels-macos
```

If `<gateway-host>` is a LAN IP without TLS, opt in for that trusted private network:

```bash
OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 \
  openclaw node run --host <gateway-lan-ip> --port 18789 --display-name parallels-macos
```

Use the same flag when installing as a LaunchAgent (it is process environment, stored in the LaunchAgent environment when present on the install command, not an `openclaw.json` setting):

```bash
OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 \
  openclaw node install --host <gateway-lan-ip> --port 18789 --display-name parallels-macos --force
openclaw node restart
```

Approve the node from the Gateway host, then confirm it advertises both `googlemeet.chrome` and browser capability/`browser.proxy`:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw nodes status
```

Route Meet through that node:

```json5
{
  gateway: {
    nodes: {
      commands: { allow: ["googlemeet.chrome", "browser.proxy"] },
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

For a one-command smoke test that creates or reuses a session, speaks a known phrase, and prints session health:

```bash
openclaw googlemeet test-speech https://meet.google.com/abc-defg-hij
```

During realtime join, browser automation fills the guest name, clicks Join/Ask to join, and accepts Meet's first-run "Use microphone" prompt when it appears (or "Continue without microphone" during observe-only join and browser-only meeting creation). If the profile is signed out, Meet is waiting for host admission, Chrome needs mic/camera permission, or Meet is stuck on an unresolved prompt, the result includes `manualAction: { reason, message }`. Stop retrying, report that message plus `browserUrl`/`browserTitle`, and retry only after the manual action completes.

If `chromeNode.node` is omitted, OpenClaw auto-selects only when exactly one connected node advertises both `googlemeet.chrome` and browser control; pin `chromeNode.node` (node id, display name, or remote IP) when several capable nodes are connected.

### Common failure checks

| Symptom                                                  | Fix                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Configured Google Meet node ... is not usable: offline` | The pinned node is known but unavailable. Report the setup blocker; do not silently fall back to another transport unless asked.                                                                                                                                                      |
| `No connected Google Meet-capable node`                  | Install `npm:@openclaw/google-meet` in the VM, run `openclaw plugins enable browser`, start `openclaw node run`, and approve pairing. If Google Meet was explicitly disabled, enable it too. Confirm `gateway.nodes.commands.allow` includes `googlemeet.chrome` and `browser.proxy`. |
| `BlackHole 2ch audio device not found`                   | On macOS, install `blackhole-2ch` on the host being checked and reboot.                                                                                                                                                                                                               |
| `PipeWire-Pulse is unavailable`                          | On Linux, start the desktop user's `pipewire-pulse` service and install `pulseaudio-utils`; do not run the node as root or outside the Chrome user's audio session.                                                                                                                   |
| Chrome opens but cannot join                             | Sign in to the browser profile in the VM, or keep `chrome.guestName` set. Guest auto-join uses OpenClaw browser automation through the node browser proxy; point the node's `browser.defaultProfile` (or a named existing-session profile) at the profile you want.                   |
| Duplicate Meet tabs                                      | Leave `chrome.reuseExistingTab: true`. OpenClaw activates an existing tab for the same URL, and creation reuses an in-progress `.../new` or Google account prompt tab, before opening another.                                                                                        |
| No audio                                                 | Route Meet mic/speaker through the virtual audio path used by OpenClaw; use separate virtual devices or Loopback-style routing for clean duplex audio.                                                                                                                                |

## Install notes

The Chrome talk-back default uses host audio tools that OpenClaw does not bundle or redistribute:

- `sox`: command-line audio utility. The plugin issues explicit CoreAudio device commands for the default 24 kHz PCM16 audio bridge.
- `blackhole-2ch`: macOS virtual audio driver providing the `BlackHole 2ch` device Chrome/Meet route through.
- `pactl`, `pacat`, and `parec`: Linux PulseAudio utilities used against PipeWire-Pulse to provision and stream through `OpenClaw Meeting Audio`.

SoX is licensed `LGPL-2.0-only AND GPL-2.0-only`; BlackHole is GPL-3.0. If you build an installer or appliance that bundles BlackHole with OpenClaw, review BlackHole's upstream licensing or get a separate license from Existential Audio.

## Transports

| Transport     | Use when                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------- |
| `chrome`      | Chrome/audio live on the Gateway host                                                        |
| `chrome-node` | Chrome/audio live on a paired node (for example a Parallels macOS VM)                        |
| `twilio`      | Phone dial-in fallback via the Voice Call plugin, when Chrome participation is not available |

### Chrome

Opens the Meet URL through OpenClaw browser control and joins as the signed-in OpenClaw browser profile. Before launch, the plugin checks or provisions the host's native virtual-audio backend and then runs any configured audio bridge health/startup command. For local Chrome, pick the profile with `browser.defaultProfile`; `chrome.browserProfile` is passed to `chrome-node` hosts instead.

```bash
openclaw googlemeet join https://meet.google.com/abc-defg-hij --transport chrome
openclaw googlemeet join https://meet.google.com/abc-defg-hij --transport chrome-node
```

Chrome mic/speaker audio routes through the local OpenClaw audio bridge. If the native backend is unavailable, the join fails with a setup error instead of joining without an audio path.

### Twilio

A strict dial plan delegated to the [Voice call plugin](/plugins/voice-call). It does not parse Meet pages for phone numbers; Google Meet must expose a phone dial-in number and PIN for the meeting.

Enable Voice Call on the Gateway host, not the Chrome node:

```json5
{
  plugins: {
    allow: ["google-meet", "voice-call", "google"],
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
          inboundPolicy: "allowlist",
          realtime: {
            enabled: true,
            provider: "google",
            instructions: "Join this Google Meet as an OpenClaw agent. Be brief.",
            toolPolicy: "safe-read-only",
            providers: {
              google: {
                silenceDurationMs: 500,
                startSensitivity: "high",
              },
            },
          },
        },
      },
      google: {
        enabled: true,
      },
    },
  },
}
```

Provide Twilio credentials through environment to keep secrets out of `openclaw.json`:

```bash
export TWILIO_ACCOUNT_SID=AC...
export TWILIO_AUTH_TOKEN=...
export TWILIO_FROM_NUMBER=+15550001234
export GEMINI_API_KEY=...
```

Use `realtime.provider: "openai"` with `OPENAI_API_KEY` instead if OpenAI is the realtime voice provider.

Restart or reload the Gateway after enabling `voice-call`; plugin config changes do not take effect until reload. Verify:

```bash
openclaw config validate
openclaw plugins list | grep -E 'google-meet|voice-call'
openclaw googlemeet setup
```

When Twilio delegation is wired, `googlemeet setup` includes `twilio-voice-call-plugin`, `twilio-voice-call-credentials`, and `twilio-voice-call-webhook` checks.

```bash
openclaw googlemeet join https://meet.google.com/abc-defg-hij \
  --transport twilio \
  --dial-in-number +15551234567 \
  --pin 123456
```

Use `--dtmf-sequence` for a custom sequence, with leading `w` or commas for a pause before the PIN:

```bash
openclaw googlemeet join https://meet.google.com/abc-defg-hij \
  --transport twilio \
  --dial-in-number +15551234567 \
  --dtmf-sequence ww123456#
```
