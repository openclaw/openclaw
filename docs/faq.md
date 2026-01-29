# Frequently Asked Questions

## General

### What is DNA?

DNA is a self-hosted AI assistant that connects to your messaging apps (WhatsApp, Telegram, Discord, Slack) and maintains persistent memory across conversations. Unlike ChatGPT or Claude's web interfaces, DNA remembers your context, preferences, and projects over time.

### How is DNA different from just using ChatGPT or Claude?

| Feature | ChatGPT/Claude Web | DNA |
|---------|-------------------|-----|
| Memory | Limited/per-session | Persistent, long-term |
| Platforms | Browser only | WhatsApp, Telegram, Discord, Slack, IDE |
| Your data | Stored on their servers | Stored on YOUR machine |
| Customization | Limited | Full control (skills, personality, tools) |
| Cost | Subscription ($20/mo) | Free + API costs (~$5-20/mo typical) |

### Is DNA free?

DNA itself is free and open source. You pay only for AI API usage:
- **Anthropic Claude:** ~$3-15 per million tokens
- **OpenAI GPT-4:** ~$5-30 per million tokens  
- **OpenRouter:** Various pricing, often cheaper
- **Ollama (local):** Free (runs on your machine)

Typical personal use: **$5-20/month** in API costs.

### What messaging platforms are supported?

- ✅ WhatsApp
- ✅ Telegram
- ✅ Discord
- ✅ Slack
- ✅ Signal
- ✅ iMessage (macOS only)

---

## Privacy & Security

### Is my data private?

Yes. DNA runs on **your** machine. Your conversations, memory files, and API keys never leave your computer (except to call the AI provider API).

### Does DNA send data to third parties?

DNA sends your messages to the AI provider you choose (Anthropic, OpenAI, etc.) for processing. No data is sent anywhere else. There's no telemetry, analytics, or tracking.

### Can I use DNA without sending data to the cloud?

Yes. Use **Ollama** with local models (Llama, Mistral, etc.). Everything runs on your machine — no internet required for AI.

### Where are my API keys stored?

Securely in your system's keychain (macOS Keychain, Windows Credential Manager, or Linux Secret Service). Not in plain text config files.

---

## Setup & Installation

### What are the system requirements?

- **OS:** macOS 12+, Ubuntu 20.04+, Windows 11 (WSL2)
- **Node.js:** 18 or higher
- **RAM:** 4GB minimum, 8GB recommended
- **Disk:** 2GB for DNA, more for local models

### How long does setup take?

About **5 minutes** for basic setup:
1. Clone repository (1 min)
2. Install dependencies (2 min)
3. Run wizard, enter API key (1 min)
4. Scan WhatsApp QR code (1 min)

### Do I need to know how to code?

No. The setup wizard guides you through everything. If you can copy-paste commands into a terminal, you can run DNA.

### Can I run DNA on a Raspberry Pi?

Yes, with limitations. DNA runs on ARM64 (Pi 4+). For AI, use a cloud API or run a small local model. Performance will be slower than a full computer.

---

## Models & AI

### What AI models does DNA support?

| Provider | Models |
|----------|--------|
| Anthropic | Claude Opus, Sonnet, Haiku |
| OpenAI | GPT-4o, GPT-4-turbo, GPT-3.5 |
| Google | Gemini Pro, Gemini Ultra |
| OpenRouter | 100+ models (one API key) |
| Ollama | Llama 3, Mistral, CodeLlama, etc. |

### Which model should I use?

- **Best quality:** Claude Opus or GPT-4
- **Balanced:** Claude Sonnet or GPT-4o (recommended)
- **Fast/cheap:** Claude Haiku or GPT-3.5
- **Privacy-focused:** Ollama with Llama 3

### Can I switch models?

Yes. Change the model in your config file or use the `/model` command in chat to switch on the fly.

### How much do API calls cost?

Rough estimates for 1 hour of active use:
- Claude Sonnet: ~$0.10-0.30
- GPT-4o: ~$0.15-0.40
- Claude Haiku: ~$0.02-0.05
- Local (Ollama): Free

---

## Features

### What are "skills"?

Skills are pre-built capabilities that extend DNA. Examples:
- **github** — Check PRs, create issues
- **weather** — Get forecasts
- **gog** — Access Gmail, Google Calendar
- **notion** — Manage Notion pages

DNA comes with 60+ skills. You can create custom skills too.

### How does memory work?

DNA maintains two types of memory:
1. **Daily notes** — Automatic logs of conversations (`memory/2025-01-29.md`)
2. **Long-term memory** — Curated facts you want remembered (`MEMORY.md`)

Memory persists across sessions. Ask DNA tomorrow about what you discussed today — it remembers.

### What is the DNA IDE?

A full-featured code editor with AI built in:
- Monaco editor (same as VS Code)
- AI chat with code context
- Inline editing (Cmd+K)
- Integrated terminal
- Git integration
- Browser preview

### Can DNA control my computer?

DNA can:
- Read and write files in your workspace
- Run terminal commands (with your permission)
- Control a browser (for web automation)
- Access your calendar and email (if configured)

All actions are logged. Destructive actions require confirmation.

---

## Troubleshooting

### DNA won't connect to WhatsApp

1. Make sure your phone has internet
2. Delete the session folder: `rm -rf ~/.dna/whatsapp-session`
3. Run `dna wizard` again and scan a fresh QR code

### API key errors

1. Check your key at the provider's website
2. Verify you have credits remaining
3. Re-add the key: `dna auth add anthropic`

### DNA is slow

1. Check your internet connection
2. Try a faster model (Haiku instead of Opus)
3. Check if you're hitting rate limits

### Where can I get help?

- **Documentation:** dna.somovselect.com/docs
- **GitHub Issues:** Report bugs and request features
- **Discord:** Join the community (coming soon)

---

## Contributing

### Is DNA open source?

Yes. MIT license. You can use, modify, and distribute DNA freely.

### How can I contribute?

1. Fork the repository
2. Create a feature branch
3. Submit a pull request

Contributions welcome: bug fixes, new skills, documentation, translations.

### Can I sell products built with DNA?

Yes. The MIT license allows commercial use. Build and sell!
