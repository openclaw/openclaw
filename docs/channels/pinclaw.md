---
summary: "Pinclaw hardware voice channel setup and configuration"
read_when:
  - You want to connect OpenClaw to a Pinclaw wearable device
  - You need Pinclaw plugin setup or relay configuration
title: Pinclaw
---

Pinclaw connects to OpenClaw via a BLE wearable device and an iOS companion app.
The plugin runs a WebSocket relay between the iPhone app and the gateway, enabling
hands-free voice input and audio output.

Status: community plugin via ClawHub. Voice input (speech-to-text via Apple and
Deepgram), text responses, audio generation (TTS), and image generation are
supported. Device skills (iOS Calendar, Reminders) are registered as agent tools.

## Install

Install the Pinclaw plugin from ClawHub:

```bash
openclaw plugins install clawhub:pinclaw
```

Or from npm:

```bash
openclaw plugins install pinclaw
```

## Setup

1. Install the plugin (see above).
2. Sign in to your Pinclaw account:

```bash
openclaw pinclaw login
```

This configures the relay connection and restarts the gateway automatically.
You can also pass credentials directly:

```bash
openclaw pinclaw login --email you@example.com --password yourpassword
```

3. Download the [Pinclaw iOS app](https://apps.apple.com/app/pinclaw/id6760344343)
   and sign in with the same account.
4. Pair your Pinclaw clip via Bluetooth in the app.

## Verify

```bash
openclaw pinclaw status
```

You should see `relay: configured`.

## Configure

The plugin auto-configures via `openclaw pinclaw login`. Manual configuration
is also supported:

```json5
{
  channels: {
    pinclaw: {
      enabled: true,
      wsPort: 18790,
      relay: {
        enabled: true,
        url: "wss://api.pinclaw.ai",
      },
    },
  },
}
```

Environment variables:

| Variable              | Purpose                    |
| --------------------- | -------------------------- |
| `PINCLAW_RELAY_TOKEN` | Relay authentication token |
| `PINCLAW_RELAY_URL`   | Relay server URL           |

## How it works

The Pinclaw system has three components:

- **Pinclaw clip** (XIAO nRF52840 Sense) -- always-on BLE voice capture.
- **iOS app** -- speech recognition, device skill bridge, relay connection.
- **This plugin** -- WebSocket channel adapter between the iOS app and the
  OpenClaw gateway.

Audio flows from the clip to the iPhone via BLE, gets transcribed on-device,
and reaches the gateway through the relay. Responses flow back through the
same path. The relay connection means the iPhone can reach the gateway from
anywhere, even when running OpenClaw on a home server.

## Two modes

- **Cloud mode** -- Pinclaw hosts a managed OpenClaw instance. No self-hosting
  required.
- **MyOpenClaw mode** -- You run OpenClaw on your own machine. The plugin
  connects via relay through the Pinclaw cloud so your iPhone can reach your
  home server from anywhere.

## Device skills

The iOS app registers native device capabilities as agent tools:

- **Calendar** -- read and create events.
- **Reminders** -- manage tasks and to-do lists.
- **Screenshot** -- capture the current screen.

The agent sees these as standard tools and calls them when relevant.

## Server tools

The plugin adds server-side tools to the gateway:

| Tool             | Description                              |
| ---------------- | ---------------------------------------- |
| `generate_image` | Generate images via AI (configurable)    |
| `generate_audio` | Generate speech via TTS APIs             |
| `memory_edit`    | Read and write persistent memory files   |

## CLI commands

| Command                   | Description                                     |
| ------------------------- | ----------------------------------------------- |
| `openclaw pinclaw login`  | Sign in, configure relay, restart gateway       |
| `openclaw pinclaw status` | Show relay connection status                    |
| `openclaw pinclaw logout` | Remove relay connection                         |

## Capabilities

| Feature          | Supported |
| ---------------- | --------- |
| DMs              | Yes       |
| Group chats      | No        |
| Voice input      | Yes       |
| Audio output     | Yes (TTS) |
| Image generation | Yes       |
| Device tools     | Yes (iOS) |
| Media attachments| No        |
| Reactions        | No        |
| Threads          | No        |

## Links

- Plugin source: [github.com/ericshang98/pinclaw](https://github.com/ericshang98/pinclaw)
- ClawHub: [clawhub.ai/plugins/pinclaw](https://clawhub.ai/plugins/ericshang98/pinclaw)
- iOS app: [App Store](https://apps.apple.com/app/pinclaw/id6760344343)
- Website: [pinclaw.ai](https://pinclaw.ai)
