# calendar

Google Calendar control for OpenClaw.

## Tools

| Tool | What it does |
|---|---|
| `calendar_list_events` | List events in a window (default: next 7 days). |
| `calendar_find_free_time` | Find free slots of N minutes in working hours. |
| `calendar_create_event` | Create an event with attendees, location, etc. |
| `calendar_quick_add` | Natural-language create — "Lunch Tuesday 1pm". |
| `calendar_update_event` | Patch any field on an existing event. |
| `calendar_delete_event` | Cancel an event. |

Write tools (`create` / `quick_add` / `update` / `delete`) are gated by
`writeEnabled: true` in config. Set it to `false` for a read-only setup.

## Wiring it up

This plugin **reuses the same Google OAuth client as `inbox-triage`**. You
just need to re-run the auth helper with the calendar scope added.

### 1. Add the calendar scope to your OAuth consent screen

Google Cloud Console → APIs & Services → OAuth consent screen → Edit App →
Scopes → Add `https://www.googleapis.com/auth/calendar`.

### 2. Re-run the auth helper

The `inbox-triage` helper has been updated to request both Gmail and
Calendar scopes by default. From your laptop:

```bash
cd extensions/inbox-triage
export GMAIL_OAUTH_CLIENT_ID=...
export GMAIL_OAUTH_CLIENT_SECRET=...
node scripts/gmail-auth.mjs
```

The new refresh token printed at the end has both scopes. Replace
`GMAIL_OAUTH_REFRESH_TOKEN` in `deploy/.env` with it.

### 3. Plugin config

Already wired in `deploy/openclaw.json`:

```json
{
  "plugins": {
    "calendar": {
      "google": {
        "user": "${GMAIL_USER}",
        "clientId": "${GMAIL_OAUTH_CLIENT_ID}",
        "clientSecret": "${GMAIL_OAUTH_CLIENT_SECRET}",
        "refreshToken": "${GMAIL_OAUTH_REFRESH_TOKEN}"
      },
      "defaultCalendarId": "primary",
      "timezone": "Europe/London",
      "writeEnabled": true
    }
  }
}
```

## Working with multiple calendars

The default is `primary` (your own calendar). To control a shared/team
calendar, pass its ID explicitly to any tool:

```
calendar_list_events(calendarId: "team@example.com")
```

You can find calendar IDs in Google Calendar → Settings → Integrate
calendar → Calendar ID.
