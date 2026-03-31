# @openclaw/strava

Strava plugin for OpenClaw — AI running coach powered by your real activity data.

## Overview

This extension connects your Strava account to OpenClaw, giving the AI agent access to your training data so it can provide personalized coaching advice. It supports running, cycling, and swimming activities.

**Tools provided:**

- `strava_auth_status` — Check connection status; get an authorization URL if not connected
- `strava_activities` — List recent activities with pace, distance, duration, heart rate, and more
- `strava_activity_detail` — Per-km splits, laps, calories, gear, and device for a single activity
- `strava_stats` — Aggregated recent, year-to-date, and all-time totals

## Installation

```bash
openclaw plugins install @openclaw/strava
```

Or from a local directory:

```bash
openclaw plugins install /path/to/extensions/strava
```

## Setup

1. **Create a Strava API app** at https://www.strava.com/settings/api
   - Set the "Authorization Callback Domain" to `localhost`

2. **Configure the plugin** with your Client ID and Client Secret:

   ```bash
   openclaw config set plugins.entries.strava.config.clientId "YOUR_CLIENT_ID"
   openclaw config set plugins.entries.strava.config.clientSecret "YOUR_CLIENT_SECRET"
   ```

   Or add directly to `~/.openclaw/openclaw.json`:

   ```json
   {
     "plugins": {
       "entries": {
         "strava": {
           "enabled": true,
           "config": {
             "clientId": "YOUR_CLIENT_ID",
             "clientSecret": "YOUR_CLIENT_SECRET"
           }
         }
       }
     }
   }
   ```

3. **Restart the gateway** and verify the plugin loaded:

   ```bash
   openclaw plugins list
   ```

4. **Connect your Strava account** — ask the AI agent to check your Strava status. It will return an authorization URL. Open it in your browser to complete the OAuth flow.

## Configuration

| Key            | Required | Description                          |
| -------------- | -------- | ------------------------------------ |
| `clientId`     | Yes      | Strava API application Client ID     |
| `clientSecret` | Yes      | Strava API application Client Secret |

## Security

- OAuth tokens are stored with `0600` permissions (owner-only read/write)
- OAuth flow uses a CSRF state nonce to prevent unauthorized account linking
- Token refresh only clears credentials on definitive auth failures (401/400), not transient errors
- The plugin requests `activity:read_all` scope (read-only access to activities)

## Testing

```bash
pnpm test:extension strava
```
