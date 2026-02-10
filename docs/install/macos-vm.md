---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Run OpenClaw in a sandboxed macOS VM (local or hosted) when you need isolation or iMessage"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want OpenClaw isolated from your main macOS environment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want iMessage integration (BlueBubbles) in a sandbox（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want a resettable macOS environment you can clone（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to compare local vs hosted macOS VM options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "macOS VMs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenClaw on macOS VMs (Sandboxing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Recommended default (most users)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Small Linux VPS** for an always-on Gateway and low cost. See [VPS hosting](/vps).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Dedicated hardware** (Mac mini or Linux box) if you want full control and a **residential IP** for browser automation. Many sites block data center IPs, so local browsing often works better.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Hybrid:** keep the Gateway on a cheap VPS, and connect your Mac as a **node** when you need browser/UI automation. See [Nodes](/nodes) and [Gateway remote](/gateway/remote).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use a macOS VM when you specifically need macOS-only capabilities (iMessage/BlueBubbles) or want strict isolation from your daily Mac.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## macOS VM options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Local VM on your Apple Silicon Mac (Lume)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run OpenClaw in a sandboxed macOS VM on your existing Apple Silicon Mac using [Lume](https://cua.ai/docs/lume).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This gives you:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Full macOS environment in isolation (your host stays clean)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iMessage support via BlueBubbles (impossible on Linux/Windows)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Instant reset by cloning VMs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No extra hardware or cloud costs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Hosted Mac providers (cloud)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want macOS in the cloud, hosted Mac providers work too:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [MacStadium](https://www.macstadium.com/) (hosted Macs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Other hosted Mac vendors also work; follow their VM + SSH docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Once you have SSH access to a macOS VM, continue at step 6 below.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick path (Lume, experienced users)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Install Lume（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. `lume create openclaw --os macos --ipsw latest`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Complete Setup Assistant, enable Remote Login (SSH)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. `lume run openclaw --no-display`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. SSH in, install OpenClaw, configure channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Done（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What you need (Lume)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Apple Silicon Mac (M1/M2/M3/M4)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS Sequoia or later on the host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ~60 GB free disk space per VM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ~20 minutes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 1) Install Lume（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `~/.local/bin` isn't in your PATH:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Verify:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
lume --version（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Lume Installation](https://cua.ai/docs/lume/guide/getting-started/installation)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2) Create the macOS VM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
lume create openclaw --os macos --ipsw latest（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This downloads macOS and creates the VM. A VNC window opens automatically.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: The download can take a while depending on your connection.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 3) Complete Setup Assistant（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In the VNC window:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Select language and region（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Skip Apple ID (or sign in if you want iMessage later)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Create a user account (remember the username and password)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Skip all optional features（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After setup completes, enable SSH:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Open System Settings → General → Sharing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Enable "Remote Login"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 4) Get the VM's IP address（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
lume get openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Look for the IP address (usually `192.168.64.x`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 5) SSH into the VM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ssh youruser@192.168.64.X（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Replace `youruser` with the account you created, and the IP with your VM's IP.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 6) Install OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inside the VM:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
npm install -g openclaw@latest（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --install-daemon（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Follow the onboarding prompts to set up your model provider (Anthropic, OpenAI, etc.).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 7) Configure channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Edit the config file:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
nano ~/.openclaw/openclaw.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Add your channels:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channels": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "whatsapp": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "dmPolicy": "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "allowFrom": ["+15551234567"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "telegram": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "botToken": "YOUR_BOT_TOKEN"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then login to WhatsApp (scan QR):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels login（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 8) Run the VM headlessly（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Stop the VM and restart without display:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
lume stop openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
lume run openclaw --no-display（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The VM runs in the background. OpenClaw's daemon keeps the gateway running.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To check status:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ssh youruser@192.168.64.X "openclaw status"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Bonus: iMessage integration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is the killer feature of running on macOS. Use [BlueBubbles](https://bluebubbles.app) to add iMessage to OpenClaw.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inside the VM:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Download BlueBubbles from bluebubbles.app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Sign in with your Apple ID（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Enable the Web API and set a password（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Point BlueBubbles webhooks at your gateway (example: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Add to your OpenClaw config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channels": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "bluebubbles": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "serverUrl": "http://localhost:1234",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "password": "your-api-password",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "webhookPath": "/bluebubbles-webhook"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Restart the gateway. Now your agent can send and receive iMessages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full setup details: [BlueBubbles channel](/channels/bluebubbles)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Save a golden image（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Before customizing further, snapshot your clean state:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
lume stop openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
lume clone openclaw openclaw-golden（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Reset anytime:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
lume stop openclaw && lume delete openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
lume clone openclaw-golden openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
lume run openclaw --no-display（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Running 24/7（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Keep the VM running by:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keeping your Mac plugged in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Disabling sleep in System Settings → Energy Saver（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Using `caffeinate` if needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For true always-on, consider a dedicated Mac mini or a small VPS. See [VPS hosting](/vps).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Problem                  | Solution                                                                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------ | ---------------------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Can't SSH into VM        | Check "Remote Login" is enabled in VM's System Settings                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| VM IP not showing        | Wait for VM to fully boot, run `lume get openclaw` again                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Lume command not found   | Add `~/.local/bin` to your PATH                                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| WhatsApp QR not scanning | Ensure you're logged into the VM (not host) when running `openclaw channels login` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [VPS hosting](/vps)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Nodes](/nodes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Gateway remote](/gateway/remote)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [BlueBubbles channel](/channels/bluebubbles)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Lume Quickstart](https://cua.ai/docs/lume/guide/getting-started/quickstart)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Lume CLI Reference](https://cua.ai/docs/lume/reference/cli-reference)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Unattended VM Setup](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (advanced)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Docker Sandboxing](/install/docker) (alternative isolation approach)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
