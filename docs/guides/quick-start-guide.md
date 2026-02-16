# OpenClaw Quick Start Guide (10 Minutes)

Get up and running with your own personal AI assistant in about 10 minutes.

## Prerequisites

Before we start, make sure you have:

- [ ] **Node.js 22+**: Run `node --version` to check. (Download from [nodejs.org](https://nodejs.org/) if needed)
- [ ] **npm** or **pnpm**: Usually comes with Node.js.
- [ ] **WhatsApp** on your phone (for the easiest first connection).
- [ ] **API Key**: An Anthropic API key (recommended) or OpenAI key.
- [ ] **10 Minutes**: That's all it takes!

## 1. Install OpenClaw

Open your terminal (Command Prompt, PowerShell, or Terminal) and run:

```bash
npm install -g openclaw@latest
```

Verify the installation:

```bash
openclaw --version
```

### Common Installation Errors
> [!WARNING]
> **Command not found?**
> If you see `command not found: openclaw` after installing, your npm binary path might not be in your system PATH.
> - **Windows**: Restart your terminal.
> - **macOS/Linux**: You might need to add npm global bin to your PATH or use `sudo` (not recommended, fix permissions instead).

## 2. Run the Setup Wizard

The wizard will guide you through the entire setup process. Run:

```bash
openclaw onboard --install-daemon
```

**What to expect:**
1.  **Welcome**: It will greet you.
2.  **Model Selection**: Choose your AI provider (Anthropic is best for OpenClaw).
3.  **API Key**: Paste your API key when prompted.
4.  **WhatsApp**: Select WhatsApp as your first channel.

## 3. Start the Gateway

After the wizard finishes, start the gateway. This is the "brain" of your assistant.

```bash
openclaw gateway --port 18789
```

You should see output indicating the gateway has started and is listening on port 18789.

## 4. Test with WhatsApp

1.  The gateway will show a **QR Code** in the terminal.
2.  Open **WhatsApp** on your phone.
3.  Go to **Linked Devices** > **Link a Device**.
4.  Scan the QR code.

Once connected, send a message to **yourself** (or the number associated with the account you just linked):

> "Hello OpenClaw!"

You should get a response from your AI assistant! Try asking:

> "/status"

This command checks the health of your assistant.

## 5. Basic Configuration

Your configuration file is located at `~/.openclaw/openclaw.json` (user home directory).

Here is a minimal working config example:

```json
{
  "agent": {
    "model": "anthropic/claude-3-5-sonnet-20240620",
    "temperature": 0.7,
    "maxTokens": 4096
  },
  "channels": {
    "whatsapp": {
      "enabled": true,
      "allowFrom": ["YOUR_PHONE_NUMBER_WITH_COUNTRY_CODE"],
      "groups": {}
    }
  }
}
```

> [!IMPORTANT]
> Always set `allowFrom` to your own phone number to prevent unauthorized access!

## 6. Common Issues & Fixes

| Issue | Likely Cause | Fix |
| :--- | :--- | :--- |
| **Gateway won't start** | Port 18789 is in use | Check if another instance is running (`openclaw doctor`) or change port in config. |
| **WhatsApp not connecting** | QR code expired or network issue | Restart the gateway to get a new QR code. Ensure your phone and computer are online. |
| **No response** | 1. Logic loop<br>2. API error<br>3. Wrong number | 1. Check terminal logs.<br>2. Check API key credit.<br>3. Verify `allowFrom` in config. |
| **High API costs** | Using expensive model | Switch to `claude-3-haiku` or similar in config. |

## 7. Next Steps

Now that you're running:
- **Add more channels**: Connect Telegram, Discord, or Slack.
- **Enable Voice**: Set up Voice Wake on macOS/iOS.
- **Browse Skills**: easy-to-add capabilities for your agent.
- **Join the Community**: [Join our Discord](https://discord.gg/clawd) for help and ideas.

## 8. Pro Tips

<details>
<summary><strong>Cost Optimization Config</strong></summary>

```json
{
  "agent": {
    "model": "anthropic/claude-3-haiku-20240307",
    "thinking": { "level": "off" }
  }
}
```
</details>

<details>
<summary><strong>Security Hardening</strong></summary>

```json
{
  "gateway": {
    "auth": { "mode": "password", "password": "STRONG_PASSWORD" },
    "bind": "127.0.0.1"
  }
}
```
</details>

## 9. Troubleshooting Commands

If things get stuck:
- `openclaw doctor`: Diagnoses common configuration and environment issues.
- `openclaw gateway --verbose`: Runs the gateway with detailed logs.
- `openclaw channels status`: Checks the connection status of your channels.
- `openclaw config validate`: Checks your configuration file for errors.
- `openclaw clear-cache`: Clears temporary data (use with caution).

## 10. Getting Help

1.  Run `openclaw doctor` first.
2.  Check the logs (`diagnostic.txt` if generated).
3.  Ask in the **#support** channel on [Discord](https://discord.gg/clawd).
4.  Check [GitHub Issues](https://github.com/openclaw/openclaw/issues).
