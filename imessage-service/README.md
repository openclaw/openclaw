# iMessage Service for Stitch

Bridges Apple iMessage to Stitch via file-based communication.
Only messages from people in macOS Contacts are visible - 2FA codes, bank alerts, and unknown senders are filtered out.

## Start

```bash
cd ~/openclaw/imessage-service
node index.js
```

## Health Check

```bash
curl http://localhost:3008/health
```

## Reload Contacts

If you add someone new to Contacts and want Stitch to see them immediately:

```bash
curl http://localhost:3008/reload-contacts
```

Otherwise the cache loads on startup.

## Permissions Needed

1. **Full Disk Access** - for reading `~/Library/Messages/chat.db`
   System Settings > Privacy & Security > Full Disk Access > enable Terminal

2. **Contacts access** - for reading Contacts to build the filter
   macOS will prompt on first run. Click "OK".

3. **Messages automation** - for sending messages via AppleScript
   macOS will prompt on first send. Click "OK".

## Test

```bash
# Read recent messages (from known contacts only)
echo '{"action":"recent","limit":5,"requested_at":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > ~/.openclaw/workspace/imessage/imessage-request.json
sleep 2
cat ~/.openclaw/workspace/imessage/imessage-response.json
```
