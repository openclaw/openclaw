# inbox-triage

Daily Gmail + WhatsApp triage skill for OpenClaw.

## What it does

At 07:00 every morning (or whenever cron fires), this plugin:

1. Pulls **unread Gmail** from the last N hours.
2. Pulls **recent inbound WhatsApp DMs** through openclaw's existing
   `whatsapp` channel adapter.
3. Sends both lists to your agent (Claude, in our case) which categorises
   each item into `URGENT` / `NEEDS_REPLY` / `FYI` / `IGNORE` and, for the
   first two, drafts a reply.
4. Renders a Markdown brief and delivers it to the configured channel
   (default: your WhatsApp self-DM).
5. Watches the same channel for `Y <id>` / `S <id>` replies — `Y` sends the
   cached draft via Gmail, `S` skips it.

It exposes one tool the agent can call: `inbox_triage_run`.

## Wiring it up

### 1. Gmail OAuth (one-time)

1. Google Cloud Console → create a project (e.g. `openclaw-personal`).
2. APIs & Services → Library → enable **Gmail API**.
3. OAuth consent screen → External, add yourself as a Test user, scope
   `https://www.googleapis.com/auth/gmail.modify`.
4. Credentials → Create OAuth client ID → **Desktop app** → download JSON.
5. Set in your env:
   ```
   export GMAIL_OAUTH_CLIENT_ID=...
   export GMAIL_OAUTH_CLIENT_SECRET=...
   ```
6. Run the helper from this directory:
   ```
   pnpm --filter @openclaw/inbox-triage gmail:auth
   ```
   It opens a browser, prints the long-lived `GMAIL_OAUTH_REFRESH_TOKEN`.

### 2. WhatsApp

WhatsApp must already be set up as an openclaw channel
(`extensions/whatsapp/` ships with this). On first boot run:

```
openclaw channels login --channel whatsapp
```

…and scan the QR code from your phone (Linked Devices).

### 3. Plugin config

In your `~/.openclaw/openclaw.json` (or the mounted file in deploy/):

```json
{
  "plugins": {
    "inbox-triage": {
      "gmail": {
        "user": "${GMAIL_USER}",
        "clientId": "${GMAIL_OAUTH_CLIENT_ID}",
        "clientSecret": "${GMAIL_OAUTH_CLIENT_SECRET}",
        "refreshToken": "${GMAIL_OAUTH_REFRESH_TOKEN}"
      },
      "deliver": {
        "channel": "whatsapp",
        "target": "${OPENCLAW_WHATSAPP_SELF_JID}"
      },
      "lookbackHours": 24,
      "draftReplies": true
    }
  }
}
```

### 4. Schedule it

```
openclaw cron add \
  --name "Daily inbox triage" \
  --cron "0 7 * * *" --tz "Europe/London" \
  --session isolated \
  --system-event "Run the inbox-triage skill: call inbox_triage_run() and report."
```
