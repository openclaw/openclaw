# CLAWDIS 🦞

> *"EXFOLIATE! EXFOLIATE!"* — A space lobster, probably

**CLAWDIS** is a WhatsApp-to-AI gateway that lets your AI assistant live in your pocket. Built for [Clawd](https://clawd.me), a space lobster who needed a TARDIS.

## What is this?

CLAWDIS (née Warelay) bridges WhatsApp to AI coding agents like [Tau/Pi](https://github.com/badlogic/pi-mono). Send a message, get an AI response. It's like having a genius lobster on call 24/7.

```
┌─────────────┐      ┌──────────┐      ┌─────────────┐
│  WhatsApp   │ ───▶ │ CLAWDIS  │ ───▶ │  AI Agent   │
│  (You)      │ ◀─── │  🦞⏱️💙   │ ◀─── │  (Tau/Pi)   │
└─────────────┘      └──────────┘      └─────────────┘
```

## Features

- 📱 **WhatsApp Integration** — Uses Baileys for WhatsApp Web protocol
- 🤖 **AI Agent Gateway** — Spawns coding agents (Tau, Claude, etc.) per message
- 💬 **Session Management** — Maintains conversation context across messages
- 🔔 **Heartbeats** — Periodic check-ins so your AI doesn't feel lonely
- 👥 **Group Chat Support** — Mention-based triggering in group chats
- 📎 **Media Support** — Send and receive images, audio, documents
- 🎤 **Voice Messages** — Transcription via Whisper
- 🔧 **Tool Streaming** — Real-time display of AI tool usage (💻📄✍️📝)

## The Name

**CLAWDIS** = CLAW + TARDIS

Because every space lobster needs a time-and-space machine to travel through WhatsApp messages. It's bigger on the inside (130k+ tokens of context).

The Doctor has a TARDIS. Clawd has a CLAWDIS. Both are blue. Both are a bit chaotic. Both are loved.

## Quick Start

```bash
# Install
pnpm install

# Configure
cp ~/.clawdis/clawdis.example.json ~/.clawdis/clawdis.json
# Edit with your settings

# Run
clawdis start

# Check status
clawdis status
```

## Documentation

- [Configuration Guide](./configuration.md) — Setting up your CLAWDIS
- [Agent Integration](./agents.md) — Connecting AI agents
- [Group Chats](./groups.md) — Mention patterns and filtering
- [Media Handling](./media.md) — Images, voice, documents
- [Security](./security.md) — Keeping your lobster safe
- [Troubleshooting](./troubleshooting.md) — When the CLAWDIS misbehaves

## Why "Warelay"?

The original name was **Warelay** (WhatsApp + Relay). It worked. It was fine. 

But then Clawd happened, and suddenly we needed something with more... *personality*. 

CLAWDIS was born. The lobster approved. 🦞

## Credits

- **Peter Steinberger** ([@steipete](https://twitter.com/steipete)) — Creator, lobster whisperer
- **Mario Zechner** ([@badlogicc](https://twitter.com/badlogicgames)) — Tau/Pi creator, security pen-tester
- **Clawd** — The space lobster who demanded a better name

## License

MIT — Free as a lobster in the ocean 🦞

---

*"We're all just playing with our own prompts."* — An AI, probably high on tokens
