# Multi-user context (checklist)

One bot, many users: each user gets a **single session key** and **one preferences file** across Telegram and WhatsApp when you use `session.dmScope: "per-peer"` and `session.identityLinks`.

Full guide: [Multi-User Context](https://docs.openclaw.ai/concepts/multi-user-context).

## Checklist

- [ ] **session.dmScope** — Set to `"per-peer"` so session keys are `agent:<agentId>:dm:<canonicalId>` (one per person).
- [ ] **session.identityLinks** — Map each person to a canonical id and their channel peer ids, e.g.:
  ```yaml
  session:
    dmScope: per-peer
    identityLinks:
      alice: ["telegram:123456789", "whatsapp:+15551234567"]
      bob: ["telegram:987654321"]
  ```
- [ ] **users/ directory** — In the agent workspace, create `users/` (or let the agent create it). One file per user, e.g. `users/dm_alice.md`, keyed by canonical id (sanitized).
- [ ] **Inject plugin** — This repo includes `plugin/user-context-inject/`. Copy it to your agent workspace at `workspace/.openclaw/extensions/user-context-inject/` and add `user-context-inject` to `plugins.allow` in config. It reads `users/<sanitized-session-key>.md` and returns `prependContext` each turn. See SETUP.md Step 10.
- [ ] **AGENTS.md / SOUL.md** — Add the snippet from [AGENTS-SNIPPET-multi-user.md](AGENTS-SNIPPET-multi-user.md) so the agent writes user preferences to `users/<key>.md` using the key from the User context block.

## Unifying Telegram + WhatsApp

- **Telegram peer id**: numeric user id (e.g. from first message or `openclaw status`).
- **WhatsApp peer id**: E.164 number, e.g. `+15551234567`.
- Add both to the **same** `identityLinks` entry so one person gets one key:
  ```yaml
  identityLinks:
    alice: ["telegram:123456789", "whatsapp:+15551234567"]
  ```
- Config hot-reloads; no gateway restart needed when you add or update identity links.

## New user (first channel)

1. User messages from Telegram or WhatsApp. Ensure they are allowlisted or paired for that channel.
2. Choose a **canonical id** (e.g. `alice`, `firstlight-ops-1`). It becomes the session key suffix and the prefs filename base.
3. Get the **peer id** for that channel (Telegram user id or WhatsApp E.164).
4. Add to `session.identityLinks`: `"alice": ["telegram:123456789"]` (or whatsapp).
5. Save config. Next message from that peer uses `agent:main:dm:alice` and `users/dm_alice.md`.

## Existing user adds another channel

1. Get the **peer id for the new channel** (e.g. WhatsApp number).
2. Append to their **existing** entry: `"alice": ["telegram:123456789", "whatsapp:+15551234567"]`.
3. Save config. Messages from either channel now use the same session and prefs file.
