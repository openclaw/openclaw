---
title: Daytona
description: Run OpenClaw in a Daytona sandbox
summary: "Deploy OpenClaw in a Daytona cloud sandbox with SSH access and secure preview URLs"
read_when:
  - Running OpenClaw in a Daytona sandbox
  - Setting up Daytona CLI and sandbox access
---

# Daytona Sandbox

**Goal:** OpenClaw Gateway running in a [Daytona](https://www.daytona.io) cloud sandbox with secure preview URL access and channel integrations.

Daytona provides isolated cloud sandboxes with SSH access and built-in preview URLs — no VPS management required. OpenClaw comes pre-installed in the `daytona-medium` snapshot, so setup starts immediately after SSH.

## What you need

- [Daytona account](https://app.daytona.io) (free tier available)
- Daytona API key from the [Daytona Dashboard](https://app.daytona.io/dashboard/keys)
- API key for your chosen model provider (Anthropic, OpenAI, etc.)

## 1) Install Daytona CLI

<Tabs>
  <Tab title="macOS / Linux">
    ```bash
    brew install daytonaio/cli/daytona
    ```
  </Tab>
  <Tab title="Windows">
    ```powershell
    powershell -Command "irm https://get.daytona.io/windows | iex"
    ```
  </Tab>
</Tabs>

Verify your installation:

```bash
daytona --version
```

Upgrade if your version is below 0.135.0.

## 2) Authenticate

```bash
daytona login --api-key=YOUR_API_KEY
```

## 3) Create a sandbox

```bash
daytona sandbox create --name openclaw --snapshot daytona-medium --auto-stop 0
```

| Flag                        | Why                                              |
| --------------------------- | ------------------------------------------------ |
| `--snapshot daytona-medium` | Minimum 2GB memory required for OpenClaw         |
| `--auto-stop 0`             | Keeps the sandbox running until manually stopped |

## 4) Connect via SSH

```bash
daytona ssh openclaw
```

## 5) Run OpenClaw onboarding

Inside the sandbox, run the interactive setup wizard:

```bash
openclaw onboard
```

Follow the prompts:

1. Accept the security acknowledgment
2. Select **Quickstart** mode
3. Choose your model provider (e.g. **Anthropic**)
4. Select **API key** auth and paste your key
5. Keep the default model
6. Skip channel setup for now (you can add channels after)
7. Skip skills and hooks
8. Select **Skip** for gateway service (you'll start it manually below)

**Note:** Save your gateway token — you'll find it in the dashboard URL after `?token=`.

## 6) Start the gateway

```bash
nohup openclaw gateway run > /tmp/gateway.log 2>&1 &
```

The gateway runs as a background process and persists after you disconnect from SSH. Verify it started:

```bash
tail -f /tmp/gateway.log
```

You should see:

```
[gateway] listening on ws://127.0.0.1:18789 (PID xxx)
```

## 7) Access the Control UI

From your **local terminal** (not the sandbox SSH session), generate a signed preview URL:

```bash
daytona preview-url openclaw --port 18789
```

The URL expires after one hour. Open it in your browser, navigate to **Overview**, paste your gateway token, and click **Connect**.

### Approve your device

After connecting, a device approval request is queued. Back in your sandbox SSH session:

```bash
# List pending requests
openclaw devices list

# Approve using the value from the Request column
openclaw devices approve REQUEST_ID
```

## Security

Daytona sandboxes apply three layers of authentication:

| Layer           | Description                                               |
| --------------- | --------------------------------------------------------- |
| Preview URL     | Time-limited signed URL (expires after 1 hour by default) |
| Gateway token   | Required to connect via the Control UI                    |
| Device approval | Each new browser or client must be explicitly approved    |

Keep your gateway token and preview URL private.

## Channel setup

### Telegram

Create a bot via [@BotFather](https://t.me/botfather) in Telegram:

1. Send `/newbot` and follow the prompts
2. Copy the bot token

Configure OpenClaw from the sandbox SSH session:

```bash
openclaw config set channels.telegram.enabled true
openclaw config set channels.telegram.botToken YOUR_BOT_TOKEN
```

Restart the gateway:

```bash
openclaw gateway stop
nohup openclaw gateway run > /tmp/gateway.log 2>&1 &
```

Start a conversation with your bot in Telegram, then approve the pairing code:

```bash
openclaw pairing approve telegram PAIRING_CODE
```

### WhatsApp

From the sandbox SSH session, run the config wizard:

```bash
openclaw config --section channels
```

Select:

- Gateway location: **Local (this machine)**
- Action: **Configure/link**
- Channel: **WhatsApp (QR link)**
- Link now: **Yes**

On your phone: **Settings → Linked Devices → Link a Device**, then scan the QR code shown in the terminal.

Once paired, you'll see:

```
✅ Linked after restart; web session ready.
```

### Set up your phone number

Select **This is my personal phone number** (or the other option if you have a separate phone for OpenClaw) and enter your phone number when prompted.

### Finish configuration

When prompted to select another channel, choose **Finished**. You'll see:

```
└  Configure complete.
```

### Start chatting

Send a message to yourself in WhatsApp — OpenClaw will respond. You can give it instructions and information on how to behave directly in the chat.

<Tip>
To allow other users to chat with OpenClaw, add their phone numbers to the **Allow From** list in **Channels → WhatsApp** inside the dashboard. When they send a message, OpenClaw will respond.
</Tip>

## Updating

```bash
daytona ssh openclaw

npm install -g openclaw@latest

openclaw gateway stop
nohup openclaw gateway run > /tmp/gateway.log 2>&1 &
```

## Stop and resume

```bash
# Stop
daytona sandbox stop openclaw

# Resume
daytona sandbox start openclaw
daytona ssh openclaw
nohup openclaw gateway run > /tmp/gateway.log 2>&1 &
```

State persists inside the sandbox across stop/start cycles.

## Troubleshooting

### Gateway not running after sandbox restart

The gateway process does not survive a sandbox restart. After `daytona ssh openclaw`, restart it:

```bash
nohup openclaw gateway run > /tmp/gateway.log 2>&1 &
```

### Preview URL expired

Preview URLs are time-limited. Regenerate from your local terminal:

```bash
daytona preview-url openclaw --port 18789
```

To avoid frequent regeneration, set a longer expiry value in seconds (default is 3600):

```bash
daytona preview-url openclaw --port 18789 --expires 86400
```

### Sandbox auto-stopped

If you forgot `--auto-stop 0` at creation, the sandbox may have stopped automatically. Resume it:

```bash
daytona sandbox start openclaw
```

To avoid this, always create with `--auto-stop 0`.

### Gateway port not reachable

Confirm the gateway is bound to port 18789 and running:

```bash
tail -20 /tmp/gateway.log
```

If the port differs, pass the correct port to `daytona preview-url`:

```bash
daytona preview-url openclaw --port YOUR_PORT
```

## Notes

- The gateway binds to `127.0.0.1` (loopback) by default; Daytona's preview proxy handles external access securely
- For programmatic sandbox provisioning via TypeScript, see the [Daytona SDK guide](https://www.daytona.io/docs/en/guides/openclaw/openclaw-sdk-sandbox/)
