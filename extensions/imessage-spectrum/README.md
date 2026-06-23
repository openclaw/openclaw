# iMessage (Spectrum)

Cross-platform iMessage channel for OpenClaw using the [Spectrum](https://spectrum.photon.codes) API by Photon.

Works on any platform: Mac, Linux, Windows, WSL, servers, containers. No macOS required.

## Features

| Feature                        | Status                                            |
| ------------------------------ | ------------------------------------------------- |
| Two-way messaging              | ✅ Production-stable                              |
| Typing indicators              | ✅ Fixed (`space.startTyping()`)                  |
| Message effects (13 types)     | ✅ `!!confetti text` syntax                       |
| Threaded replies               | ✅ `message.reply()` with `space.send()` fallback |
| Outbound tapbacks              | ✅ love/like/dislike/laugh/emphasize/question     |
| Inbound reaction detection     | ✅ Logged in health endpoint                      |
| Group chat renaming            | ✅ `sendSpectrumRename()`                         |
| Group avatars                  | ✅ `sendSpectrumAvatar()`                         |
| Chat backgrounds               | ✅ `sendSpectrumBackground()`                     |
| Contact cards                  | ✅ `sendSpectrumContactCard()`                    |
| Mini-app cards                 | ✅ `sendSpectrumMiniAppCard()`                    |
| Attachment fetching            | ✅ `sendSpectrumGetAttachment()`                  |
| Retry queue                    | ✅ 5x exponential backoff                         |
| Startup catchup                | ✅ Replays missed messages on restart             |
| Media (images/files/voice)     | ✅                                                |
| Markdown text                  | ✅                                                |
| Doctor diagnostics             | ✅ `openclaw doctor imessage-spectrum`            |
| Automated webhook registration | ✅ `--register-webhook` flag                      |
| Health endpoint                | ✅ `/channels/imessage-spectrum/health`           |

## Quick Start

### 1. Add the channel

```sh
openclaw channels add imessage-spectrum
```

Or with all options:

```sh
openclaw channels add imessage-spectrum \
  --project-id "photon_project_id" \
  --project-secret "photon_project_secret" \
  --webhook-base-url "https://your-gateway.example.com"
```

### 2. Set up a tunnel

Expose the gateway with a public HTTPS URL:

```sh
# Cloudflare Tunnel example
cloudflared tunnel --url http://localhost:18789
```

Save the URL:

```sh
openclaw config set channels.imessage-spectrum.webhookBaseUrl https://your-tunnel-url.example.com
```

### 3. Register the webhook

```sh
openclaw channels add imessage-spectrum --register-webhook
```

This registers with Photon and saves the signing secret automatically.

### 4. Restart and verify

```sh
openclaw gateway restart
curl https://your-tunnel-url.example.com/channels/imessage-spectrum/health
```

## Message Effects

Send iMessage effects by prefixing text with `!!effect_name`:

| Syntax               | Effect Type                         |
| -------------------- | ----------------------------------- |
| `!!slam text`        | Slam (bubble slam)                  |
| `!!loud text`        | Loud (bubble shout)                 |
| `!!gentle text`      | Gentle (bubble whisper)             |
| `!!invisible text`   | Invisible ink (hidden until swiped) |
| `!!confetti text`    | Confetti (full screen)              |
| `!!fireworks text`   | Fireworks (full screen)             |
| `!!balloons text`    | Balloons (full screen)              |
| `!!heart text`       | Heart (full screen)                 |
| `!!lasers text`      | Lasers (full screen)                |
| `!!celebration text` | Celebration (full screen)           |
| `!!sparkles text`    | Sparkles (full screen)              |
| `!!spotlight text`   | Spotlight (full screen)             |
| `!!echo text`        | Echo (full screen)                  |

The `!!effect` prefix is automatically stripped from the visible text.

## Tapbacks

Send reactions to messages:

| Tapback      | Command                                             |
| ------------ | --------------------------------------------------- |
| ❤️ Love      | `sendSpectrumReaction(msgId, spaceId, "love")`      |
| 👍 Like      | `sendSpectrumReaction(msgId, spaceId, "like")`      |
| 👎 Dislike   | `sendSpectrumReaction(msgId, spaceId, "dislike")`   |
| 😂 Laugh     | `sendSpectrumReaction(msgId, spaceId, "laugh")`     |
| 🙌 Emphasize | `sendSpectrumReaction(msgId, spaceId, "emphasize")` |
| ❓ Question  | `sendSpectrumReaction(msgId, spaceId, "question")`  |

## CLI Commands

| Command                                                                         | Purpose                             |
| ------------------------------------------------------------------------------- | ----------------------------------- |
| `openclaw channels add imessage-spectrum`                                       | Add account (interactive)           |
| `openclaw channels add imessage-spectrum --project-id ... --project-secret ...` | Add account (non-interactive)       |
| `openclaw channels add imessage-spectrum --register-webhook`                    | Add account + auto-register webhook |
| `openclaw doctor imessage-spectrum`                                             | Run diagnostics                     |
| `openclaw config set channels.imessage-spectrum.webhookBaseUrl <url>`           | Set public base URL                 |

## Health Endpoint

```
GET /channels/imessage-spectrum/health
```

Returns JSON with:

- Connection status
- Queue depth
- Last inbound/outbound activity
- Last delivery error
- Catchup cursor position

## Diagnostics

```sh
openclaw doctor imessage-spectrum
```

Checks:

- Project configuration
- Connection to Photon
- Webhook registration
- Tunnel status
- Queue health

## Architecture

```
iMessage App ←→ Photon Cloud ←→ Spectrum SDK ←→ OpenClaw Gateway
                          ↕
               Webhook (HTTPS POST)
```

The gateway connects to Photon via the Spectrum SDK, sends/receives iMessages through the Photon cloud API, and exposes a webhook endpoint for inbound messages.

## Configuration

Config keys under `channels.imessage-spectrum`:

| Key              | Required    | Description                                    |
| ---------------- | ----------- | ---------------------------------------------- |
| `projectId`      | ✅          | Spectrum project ID                            |
| `projectSecret`  | ✅          | Spectrum project secret                        |
| `webhookSecret`  | For inbound | Photon webhook signing secret                  |
| `webhookBaseUrl` | For inbound | Public HTTPS URL of the gateway                |
| `enabled`        |             | Enable/disable the channel                     |
| `dmPolicy`       |             | Direct message policy (pairing/allowlist/open) |
| `allowFrom`      |             | Allowed senders                                |

## Troubleshooting

**"Webhook not registered"**
Run `openclaw channels add imessage-spectrum --register-webhook` after setting `webhookBaseUrl`.

**"Channel not connected"**
Check the health endpoint. Ensure the tunnel is running and webhookBaseUrl is reachable from Photon.

**"Messages not arriving"**
Check that webhookSecret is set (it's returned by `--register-webhook` or the manual curl command).

**"Typing indicators not working"**
The typing indicator fix requires the updated `channel.runtime.ts` from this PR. Verify `space.startTyping()` is being called by checking `openclaw doctor imessage-spectrum`.
