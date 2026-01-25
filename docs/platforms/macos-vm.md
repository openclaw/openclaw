---
summary: "Run Clawdbot in a sandboxed macOS VM on your existing Apple Silicon Mac using Lume"
read_when:
  - You want Clawdbot isolated from your main macOS environment
  - You want iMessage integration (BlueBubbles) in a sandbox
  - You already have an Apple Silicon Mac and don't want to buy extra hardware
  - You want to reset your Clawdbot environment easily by cloning VMs
---

# Clawdbot on Lume (macOS Sandbox)

## Goal

Run Clawdbot in a sandboxed macOS VM on your existing Apple Silicon Mac using [Lume](https://cua.ai/docs/lume).

This gives you:
- Full macOS environment in isolation (your host stays clean)
- iMessage support via BlueBubbles (impossible on Linux/Windows)
- Instant reset by cloning VMs
- No extra hardware or cloud costs

## What are we doing?

- Install Lume on your Mac (VM manager using Apple's Virtualization Framework)
- Create a macOS VM
- SSH into the VM
- Install and configure Clawdbot inside the VM
- Run the VM headlessly in the background

The Gateway runs inside the VM. You access it via SSH or the VM's IP.

---

## Quick path (experienced users)

1. Install Lume
2. `lume create clawdbot --os macos --ipsw latest`
3. Complete Setup Assistant, enable Remote Login (SSH)
4. `lume run clawdbot --no-display`
5. SSH in, install Clawdbot, configure channels
6. Done

---

## What you need

- Apple Silicon Mac (M1/M2/M3/M4)
- macOS Sequoia or later on the host
- ~60 GB free disk space per VM
- ~20 minutes

---

## 1) Install Lume

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

If `~/.local/bin` isn't in your PATH:

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

Verify:

```bash
lume --version
```

Docs: [Lume Installation](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2) Create the macOS VM

```bash
lume create clawdbot --os macos --ipsw latest
```

This downloads macOS and creates the VM. A VNC window opens automatically.

Note: The download can take a while depending on your connection.

---

## 3) Complete Setup Assistant

In the VNC window:
1. Select language and region
2. Skip Apple ID (or sign in if you want iMessage later)
3. Create a user account (remember the username and password)
4. Skip all optional features

After setup completes, enable SSH:
1. Open System Settings → General → Sharing
2. Enable "Remote Login"

---

## 4) Get the VM's IP address

```bash
lume get clawdbot
```

Look for the IP address (usually `192.168.64.x`).

---

## 5) SSH into the VM

```bash
ssh youruser@192.168.64.X
```

Replace `youruser` with the account you created, and the IP with your VM's IP.

---

## 6) Install Clawdbot

Inside the VM:

```bash
npm install -g clawdbot@latest
clawdbot onboard --install-daemon
```

Follow the onboarding prompts to set up your model provider (Anthropic, OpenAI, etc.).

---

## 7) Configure channels

Edit the config file:

```bash
nano ~/.clawdbot/clawdbot.json
```

Add your channels:

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    },
    "telegram": {
      "botToken": "YOUR_BOT_TOKEN"
    }
  }
}
```

Then login to WhatsApp (scan QR):

```bash
clawdbot channels login
```

---

## 8) Run the VM headlessly

Stop the VM and restart without display:

```bash
lume stop clawdbot
lume run clawdbot --no-display
```

The VM runs in the background. Clawdbot's daemon keeps the gateway running.

To check status:

```bash
ssh youruser@192.168.64.X "clawdbot status"
```

---

## Bonus: iMessage integration

This is the killer feature of running on macOS. Use [BlueBubbles](https://bluebubbles.app) to add iMessage to Clawdbot.

Inside the VM:

1. Download BlueBubbles from bluebubbles.app
2. Sign in with your Apple ID
3. Enable the Web API in BlueBubbles settings

Add to your Clawdbot config:

```json
{
  "channels": {
    "bluebubbles": {
      "serverUrl": "http://localhost:1234",
      "password": "your-api-password"
    }
  }
}
```

Restart the gateway. Now your agent can send and receive iMessages.

---

## Save a golden image

Before customizing further, snapshot your clean state:

```bash
lume stop clawdbot
lume clone clawdbot clawdbot-golden
```

Reset anytime:

```bash
lume stop clawdbot && lume delete clawdbot
lume clone clawdbot-golden clawdbot
lume run clawdbot --no-display
```

---

## Running 24/7

Keep the VM running by:
- Keeping your Mac plugged in
- Disabling sleep in System Settings → Energy Saver
- Using `caffeinate` if needed

For true always-on, consider a dedicated Mac Mini or cloud Mac instances.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Can't SSH into VM | Check "Remote Login" is enabled in VM's System Settings |
| VM IP not showing | Wait for VM to fully boot, run `lume get clawdbot` again |
| Lume command not found | Add `~/.local/bin` to your PATH |
| WhatsApp QR not scanning | Ensure you're logged into the VM (not host) when running `clawdbot channels login` |

---

## Related docs

- [Lume Quickstart](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI Reference](https://cua.ai/docs/lume/reference/cli-reference)
- [Unattended VM Setup](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (advanced)
- [Docker Sandboxing](/install/docker) (alternative isolation approach)
