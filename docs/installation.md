# Installation Guide

This guide walks you through installing DNA on your system.

## System Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| **OS** | macOS 12+, Ubuntu 20.04+, Windows 11 (WSL2) | macOS 13+, Ubuntu 22.04+ |
| **Node.js** | 18.0 | 20.0+ |
| **RAM** | 4 GB | 8 GB+ |
| **Disk** | 2 GB | 10 GB+ |
| **Internet** | Required for AI providers | Stable connection |

## Quick Install

### macOS / Linux

```bash
# Clone repository
git clone https://github.com/vanek-nutic/dna.git
cd dna

# Install dependencies
npm install

# Build TypeScript
npm run build

# Run setup wizard
./dna.mjs wizard
```

### Windows (WSL2)

1. Install WSL2 with Ubuntu:
```powershell
wsl --install -d Ubuntu
```

2. Inside WSL, follow Linux instructions above.

---

## Step-by-Step Installation

### 1. Install Node.js

**macOS (Homebrew):**
```bash
brew install node@20
```

**Ubuntu/Debian:**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Verify installation:**
```bash
node --version  # Should be 18+
npm --version   # Should be 9+
```

### 2. Clone DNA

```bash
git clone https://github.com/vanek-nutic/dna.git
cd dna
```

### 3. Install Dependencies

```bash
npm install
```

This installs all required packages. May take a few minutes.

### 4. Build

```bash
npm run build
```

Compiles TypeScript to JavaScript.

### 5. Run Setup Wizard

```bash
./dna.mjs wizard
```

The wizard guides you through:

#### a) Choose AI Provider

```
? Select AI provider:
  ❯ Anthropic (Claude) — Recommended
    OpenAI (GPT-4)
    Google (Gemini)
    OpenRouter (Multiple models)
    Ollama (Local, free)
```

#### b) Enter API Key

Get your API key from:
- **Anthropic:** https://console.anthropic.com/
- **OpenAI:** https://platform.openai.com/api-keys
- **OpenRouter:** https://openrouter.ai/keys

```
? Enter your API key: sk-ant-xxxxxxxxxxxxx
✓ Key saved securely to keychain
```

#### c) Connect Messaging (Optional)

**WhatsApp:**
```
? Connect WhatsApp? Yes
Scan this QR code with WhatsApp:
[QR CODE DISPLAYED]
✓ WhatsApp connected!
```

**Telegram:**
```
? Connect Telegram? Yes
? Enter bot token from @BotFather: 123456:ABC-xxxxx
✓ Telegram connected!
```

#### d) Set Workspace

```
? Workspace directory: ~/dna-workspace
✓ Workspace created with templates
```

### 6. Start DNA

```bash
# Run in background (daemon)
./dna.mjs gateway start

# Or run in foreground (see logs)
./dna.mjs gateway run
```

### 7. Verify Installation

```bash
./dna.mjs status
```

Should show:
```
DNA Gateway
  Status: Running
  Port: 18790
  Channels: WhatsApp (connected)
  Model: anthropic/claude-sonnet-4
```

---

## Post-Installation

### Set Up Your Workspace

Copy templates to your workspace:
```bash
cp -R workspace-template/* ~/dna-workspace/
```

Edit these files:
- `USER.md` — Information about yourself
- `SOUL.md` — Customize AI personality
- `TOOLS.md` — Add your specific tool notes

### Test the Connection

Send a message to your connected channel (WhatsApp, Telegram, etc.):
```
Hello, are you working?
```

DNA should respond.

### Install DNA IDE (Optional)

```bash
cd extensions/ide
npm install
npm start
```

Open http://localhost:3333

---

## Running as a Service

### macOS (launchd)

Create `~/Library/LaunchAgents/com.dna.gateway.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.dna.gateway</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/dna/dna.mjs</string>
        <string>gateway</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

Load it:
```bash
launchctl load ~/Library/LaunchAgents/com.dna.gateway.plist
```

### Linux (systemd)

Create `/etc/systemd/system/dna.service`:

```ini
[Unit]
Description=DNA Gateway
After=network.target

[Service]
Type=simple
User=yourusername
WorkingDirectory=/path/to/dna
ExecStart=/usr/bin/node dna.mjs gateway run
Restart=always

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable dna
sudo systemctl start dna
```

---

## Troubleshooting

### "Command not found: node"
Install Node.js (see Step 1).

### "Permission denied"
```bash
chmod +x dna.mjs
```

### WhatsApp won't connect
- Make sure your phone has internet
- Try `./dna.mjs wizard` again for new QR code
- Check firewall isn't blocking connections

### API key errors
- Verify your key at the provider's website
- Check you have credits/quota remaining
- Run `./dna.mjs auth add` to re-enter key

### See logs
```bash
./dna.mjs gateway logs
```

---

## Updating DNA

```bash
cd /path/to/dna
git pull
npm install
npm run build
./dna.mjs gateway restart
```

---

## Uninstalling

1. Stop the gateway:
```bash
./dna.mjs gateway stop
```

2. Remove the directory:
```bash
rm -rf /path/to/dna
```

3. Remove config (optional):
```bash
rm -rf ~/.dna
```

4. Remove from keychain (optional):
```bash
# macOS
security delete-generic-password -s "dna-anthropic"
```
