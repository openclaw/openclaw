# Integrations & Messaging (WhatsApp, Telegram, etc.)

This doc clarifies how **OpenClaw main** (Gateway) and **OpenClaw agent-system** use messaging and integrations.

---

## 1. OpenClaw main (Gateway) – user-facing channels

The **main** OpenClaw product provides **channels** so users talk to the Pi agent from:

- **WhatsApp** (Baileys)
- **Telegram** (grammY)
- **Slack**, **Discord**, **Google Chat**, **Signal**, **iMessage**, **BlueBubbles**, **Microsoft Teams**, **Matrix**, **Zalo**, **WebChat**

So: **WhatsApp and Telegram in main = where users chat with the AI.**  
Configuration is in the Gateway (e.g. `channels.telegram`, `channels.whatsapp`). See [OpenClaw Channels](https://docs.openclaw.ai/channels).

---

## 2. OpenClaw agent-system – business agents & alerts

The **agent-system** runs **business agents** (Finance, Operations, etc.) that:

- Use **integrations** for data: Stripe, GitHub, Notion, Gmail, etc. (API keys / tokens in config).
- Can send **notifications** to operators (alerts, failures, summaries).

**Config (backend):**

- `telegram_bot_token`, `telegram_chat_id` – for **sending alerts** (e.g. to a Telegram chat) when agents fail or report.
- No WhatsApp/Slack in agent-system config today; they could be added for alert delivery similarly (webhook or API).

**Notification model:** `Notification` has a `channels` field (e.g. `["telegram", "email", "desktop"]`). **Sending** is not implemented yet: the agent-system stores notifications but does not call Telegram/WhatsApp APIs to deliver them. Implementing that would mean:

- For **Telegram:** use `telegram_bot_token` to call Telegram Bot API (sendMessage to `telegram_chat_id`).
- For **WhatsApp:** would require WhatsApp Business API or a provider (e.g. Twilio, Cloud API) and corresponding config.

---

## 3. Two-way WhatsApp ↔ Telegram (external)

For **unified customer support** (one inbox for WhatsApp + Telegram), use external tools:

- **n8n / Make / BuildShip:** workflows that sync messages between WhatsApp and Telegram (and optionally CRM).
- **Requirements:** WhatsApp Cloud API credentials, Telegram Bot token, DB for mapping, webhooks.

The agent-system does **not** implement this; it is a separate integration pattern you would build or use via automation platforms.

---

## 4. Summary

| Where | WhatsApp / Telegram role |
|-------|---------------------------|
| **OpenClaw main** | User-facing **channels**: users message the AI on WhatsApp/Telegram/etc. |
| **OpenClaw agent-system** | **Alerts** to operator (Telegram configured; delivery not yet wired). Integrations (Stripe, GitHub, etc.) for agent data. |
| **External (n8n, Make)** | Two-way sync / aggregator between messaging platforms. |

To **wire Telegram alerts** in the agent-system: add a small notification sender that, when a `Notification` is created with `"telegram"` in `channels`, calls the Telegram Bot API with `telegram_bot_token` and `telegram_chat_id`.
