---
summary: "FAQ (concepts): what Clawdbot is and how it fits together"
read_when:
  - You’re new and want the mental model
  - You’re not debugging a specific error
---

# FAQ (concepts)

If you’re here because something’s broken, start with: [Troubleshooting](/help/troubleshooting).

## What is Clawdbot?

Clawdbot is a personal AI assistant you run on your own devices. It replies on the messaging surfaces you already use (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, WebChat) and can also do voice + a live Canvas on supported platforms. The **Gateway** is the always‑on control plane; the assistant is the product.

## What runtime do I need?

Node **>= 22** is required. `pnpm` is recommended. Bun is **not recommended** for the Gateway.

## What’s the recommended setup flow?

Use the onboarding wizard:

```bash
clawdbot onboard --install-daemon
```

Then use:

```bash
clawdbot dashboard
```
