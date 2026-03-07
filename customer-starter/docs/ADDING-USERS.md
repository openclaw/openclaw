# Adding users (Telegram and WhatsApp)

Steps to **enable** Telegram and WhatsApp and then **add users** so they can message the bot and (with multi-user context) get one session and one prefs file per person.

## 1. Enable Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather); copy the token.
2. In config (`config/openclaw.yml` or your OpenClaw config dir):
   ```yaml
   channels:
     telegram:
       enabled: true
       botToken: "YOUR_BOT_TOKEN"
       dmPolicy: pairing # or allowlist (see below)
   ```
   Or set env `TELEGRAM_BOT_TOKEN`.
3. Start the gateway. On first DM, the user gets a **pairing code**; approve it (Control UI or CLI: `openclaw pairing` / allowlist).
4. **Peer id**: After the user messages, get their Telegram user id from session metadata or `openclaw status` (numeric, e.g. `123456789`). Use it in `session.identityLinks` as `telegram:123456789`.

**Allowlist instead of pairing:** Set `dmPolicy: allowlist` and `allowFrom: ["123456789"]` (Telegram user ids). Then only those ids can DM; no pairing step.

## 2. Enable WhatsApp

1. Use a **dedicated phone number** (or WhatsApp Business with a separate number). Configure the channel:
   ```yaml
   channels:
     whatsapp:
       dmPolicy: allowlist
       allowFrom: ["+15551234567"] # E.164, add more as needed
   ```
2. Run **`openclaw channels login`** and scan the QR code (Linked Devices). Keep the gateway running so the session stays active.
3. **Peer id**: WhatsApp peer id is the E.164 number (e.g. `+15551234567`). Use it in `session.identityLinks` as `whatsapp:+15551234567`.

**Pairing (optional):** Set `dmPolicy: pairing` so unknown senders get a pairing code; approve via Control UI or CLI, then add them to `identityLinks` and optionally to `allowFrom` if you use allowlist elsewhere.

## 3. Add a user (multi-user context)

Once Telegram and/or WhatsApp are enabled and the user has messaged at least once:

1. Choose a **canonical id** for them (e.g. `alice`, `firstlight-jane`).
2. Get **peer ids**:
   - **Telegram**: numeric user id (e.g. from gateway logs, session list, or status).
   - **WhatsApp**: E.164 number of the account that messaged.
3. Edit `session.identityLinks` in your config:
   ```yaml
   session:
     dmScope: per-peer
     identityLinks:
       alice: ["telegram:123456789"]           # first channel
       # later, when they add WhatsApp:
       alice: ["telegram:123456789", "whatsapp:+15551234567"]
   ```
4. Save; config hot-reloads. From then on, that user’s messages (from either channel) use session key `agent:main:dm:alice` and prefs file `users/dm_alice.md`.

## 4. Quick reference (peer id format)

| Channel  | Peer id format  | Example        |
| -------- | --------------- | -------------- |
| Telegram | Numeric user id | `123456789`    |
| WhatsApp | E.164 number    | `+15551234567` |

In `identityLinks` always prefix with the channel: `telegram:123456789`, `whatsapp:+15551234567`.

## Links

- [Telegram](https://docs.openclaw.ai/channels/telegram) — Bot setup, dmPolicy, groups.
- [WhatsApp](https://docs.openclaw.ai/channels/whatsapp) — Login, allowlist, pairing.
- [Multi-user context](https://docs.openclaw.ai/concepts/multi-user-context) — identityLinks, per-user files, inject plugin.
