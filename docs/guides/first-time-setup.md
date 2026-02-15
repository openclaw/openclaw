# First-Time Setup Guide (GlobalCaos Fork)

This guide walks you through setting up OpenClaw from our fork, with all the enhancements pre-configured.

## Prerequisites

- **Ubuntu 22.04+** (or compatible Linux)
- **Node.js 20+** (we recommend using `nvm`)
- **At least one AI API key** (Anthropic or Google)

## Step 1: Clone the Repository

```bash
git clone https://github.com/globalcaos/clawdbot-moltbot-openclaw.git openclaw
cd openclaw
```

## Step 2: Install Dependencies

```bash
npm install
```

## Step 3: Run the Setup Wizard

```bash
npx openclaw init
```

The wizard will ask for:
- Your name (for the AI to address you)
- Your phone number (for WhatsApp allowlist)
- Your primary AI provider

## Step 4: Add Your API Keys

Edit `~/.openclaw/openclaw.json`:

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "sk-ant-api03-YOUR-KEY-HERE"
    },
    "google": {
      "apiKey": "AIzaSy-YOUR-KEY-HERE"
    }
  }
}
```

### Getting API Keys

| Provider | Where to Get | Cost |
|----------|--------------|------|
| Anthropic (Claude) | [console.anthropic.com](https://console.anthropic.com) | Pay-as-you-go |
| Google (Gemini) | [aistudio.google.com](https://aistudio.google.com) | Free tier available |

## Step 5: Link WhatsApp (Optional)

```bash
npx openclaw channels login
```

Scan the QR code with WhatsApp (Settings → Linked Devices).

**Tip:** Use a separate phone number if possible. We recommend a cheap prepaid SIM or eSIM.

## Step 6: Start the Gateway

```bash
npx openclaw gateway start
```

You should see:
```
✓ Gateway started (pid 12345)
✓ WhatsApp connected
✓ Ready
```

## Step 7: Talk to Your AI

Send a WhatsApp message to your linked number:
> "Hello! What can you help me with?"

Or use the web chat:
```bash
npx openclaw chat
```

## Step 8: Let the AI Configure Itself

Once connected, tell your AI:
> "Read FORK.md and configure the recommended settings for me."

The AI will:
1. Enable Smart Router for cost savings
2. Set up failover to Gemini
3. Configure WhatsApp for full access
4. Install recommended skills

---

## What's Pre-Configured in This Fork

### Security (Already Applied)
- DNS rebinding protection
- Zip path traversal fix
- WebSocket authentication

### Cost Optimization (Already Applied)
- Smart Router V2 (auto model selection)
- Rate limiting (prevents runaway costs)
- Failover chain (Claude → Gemini)

### Skills (Already Installed)
- `youtube-ultimate` — Free YouTube transcripts
- `google-sheets` — Spreadsheet automation
- `healthcheck` — System security audits

---

## Troubleshooting

### "WhatsApp not connecting"
```bash
npx openclaw doctor
npx openclaw channels login  # Re-link
```

### "Rate limit errors"
The failover should handle this automatically. Check:
```bash
npx openclaw status
```

### "Command not found: openclaw"
Make sure you're in the openclaw directory, or install globally:
```bash
npm link
```

---

## Next Steps

1. **Explore Skills:** `npx openclaw skills list`
2. **Check Status:** `npx openclaw status`
3. **Read Docs:** `npx openclaw docs`

Welcome to the trust-first AI assistant experience! 🦎
