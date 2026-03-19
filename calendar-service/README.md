# Calendar Service for Stitch

Bridges Apple Calendar to Stitch via file-based communication.

## Start

```bash
cd ~/openclaw/calendar-service
node index.js
```

## Health Check

```bash
curl http://localhost:3007/health
```

## First Run

macOS will prompt for Calendar access permission. Click "OK" to grant access.
If permission was denied, go to System Settings > Privacy & Security > Calendars
and enable access for Terminal.

## Auto-start (optional)

To run on login, add to your shell profile or create a launchd plist.
