# Mission

## What this is

OpenClaw is a single-user personal AI assistant you run on your own devices. A local Gateway acts as the control plane: it accepts inbound messages from the chat apps you already use (WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, BlueBubbles, Microsoft Teams, Matrix, Zalo, Zalo Personal, WebChat), routes them to isolated agent sessions, executes tools (browser, canvas, cron, skills, device nodes), and sends replies back through the same channel. Companion apps (macOS menu bar, iOS, Android) add Voice Wake, Talk Mode, and a live agent-driven Canvas surface. The Gateway is the plumbing; the product is the assistant that reaches you wherever you already chat.

## Who it serves

The operator who wants their *own* AI assistant — running on their own host, paired to their own accounts, gated by their own allowlist — and who is comfortable installing a CLI, configuring channels, and bringing their own model credentials (Anthropic Pro/Max recommended; OpenAI, Bedrock, Gemini, OpenRouter, MiniMax, Kimi/Moonshot, Qwen, Copilot, Ollama, etc. all supported).

## What it is NOT

- **Not a multi-tenant SaaS chatbot.** One Gateway, one operator. There is no team plan, no shared workspace, no centralized hosted backend.
- **Not a customer-support / helpdesk bot.** Inbound DMs are treated as untrusted; the default DM policy is `pairing`, not open.
- **Not a foundation model.** OpenClaw orchestrates third-party model providers; it does not train or host models.
- **Not the Gateway alone.** The Gateway is the control plane, not the product. Channels, voice, canvas, skills, and apps are the product surface.
- **Not a chat UI product.** WebChat exists for control; the assistant is meant to live inside the chat apps the operator already uses.
- **Not stream-friendly to external surfaces.** Streaming/partial replies stay on internal UIs; external messaging surfaces (WhatsApp/Telegram/etc.) receive final replies only.

## Success signal

The operator keeps the Gateway daemon running and uses the assistant from their phone — on their existing chat apps — instead of opening a separate chat UI.
