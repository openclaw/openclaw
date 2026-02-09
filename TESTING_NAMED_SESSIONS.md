# Testing Named Persistent Sessions

This guide helps you test the newly implemented named persistent sessions feature.

## Prerequisites

1. Build the updated code:

   ```bash
   cd ~/Documents/sourcecode/openclaw
   npm run build
   ```

2. Restart the gateway:
   ```bash
   openclaw gateway restart
   ```

## Test Plan

### 1. Backend API Tests

#### Test creating a session via API:

```bash
curl -X POST http://localhost:5004 \
  -H "Content-Type: application/json" \
  -d '{
    "method": "sessions.create",
    "params": {
      "label": "Test Session",
      "description": "My test session",
      "persistent": true
    },
    "id": 1
  }'
```

Expected response:

```json
{
  "ok": true,
  "key": "agent:main:named:<uuid>",
  "sessionId": "<uuid>",
  "entry": { ... }
}
```

#### Test listing sessions:

```bash
curl -X POST http://localhost:5004 \
  -H "Content-Type: application/json" \
  -d '{
    "method": "sessions.list",
    "params": {},
    "id": 2
  }'
```

Should return your newly created session with `persistent: true`.

#### Test resetting a persistent session (should fail):

```bash
curl -X POST http://localhost:5004 \
  -H "Content-Type: application/json" \
  -d '{
    "method": "sessions.reset",
    "params": {
      "key": "<your-persistent-session-key>"
    },
    "id": 3
  }'
```

Expected: Error message about not being able to reset persistent sessions.

### 2. Command Tests (Via Chat)

#### Create a session:

```
/session new Work Session
```

Expected output:

- ✅ Created session "Work Session"
- Key: agent:main:named:<uuid>
- This session is persistent...

#### List sessions:

```
/session list
```

Expected output:

- Shows "Named Sessions" section
- Your new "Work Session" appears with a badge
- Shows update time and token count

#### Try to reset a persistent session:

1. Switch to your named session via URL: `?session=<key>`
2. Type: `/new` or `/reset`
3. Expected: Error message saying session is persistent

### 3. UI Tests

#### Sessions List:

1. Open Control UI: http://localhost:5004
2. Navigate to "Sessions" tab
3. Verify:
   - Your named session appears in the list
   - 📌 badge shows next to persistent sessions
   - Hovering shows tooltip "Persistent session (won't reset on /new)"

#### URL Switching:

1. Open webchat: http://localhost:5004
2. Add `?session=<your-session-key>` to URL
3. Verify:
   - Session switches
   - Context is separate from main session
4. Remove URL param (return to main)
5. Add URL param again
6. Verify context was preserved

### 4. Integration Tests

#### Multi-session workflow:

1. Create "Work Session": `/session new Work Session`
2. Create "Personal Session": `/session new Personal Session`
3. Switch to Work Session via URL
4. Have a conversation about work
5. Switch to Personal Session via URL
6. Have a different conversation
7. Switch back to Work Session
8. Verify: Work conversation context is intact

#### Persistence test:

1. Create a named session
2. Have a conversation in it
3. Try `/new` - should fail
4. Switch to main session via URL
5. Try `/new` - should work (main not persistent by default)
6. Switch back to named session
7. Verify: Named session context still intact

### 5. Edge Cases

#### Test session with special characters in name:

```
/session new Test: Special/Characters & Symbols!
```

Should create successfully.

#### Test empty session name:

```
/session new
```

Should show error: "Usage: /session new <name>"

#### Test very long session name:

```
/session new <paste 200 characters>
```

Should either accept (max 100 chars) or reject gracefully.

#### Test basedOn parameter:

```bash
curl -X POST http://localhost:5004 \
  -H "Content-Type: application/json" \
  -d '{
    "method": "sessions.create",
    "params": {
      "label": "Copy of Main",
      "basedOn": "main",
      "persistent": true
    },
    "id": 4
  }'
```

Should copy preferences from main session.

## Expected Behavior Summary

✅ **What Should Work:**

- Creating named sessions via `/session new <name>`
- Listing all sessions via `/session list`
- Sessions show as persistent in UI with 📌 badge
- Persistent sessions cannot be reset via `/new` or `/reset`
- Session context is isolated between sessions
- Switching between sessions via URL parameter
- Session preferences (thinking, verbose, etc.) are independent

❌ **What Should Fail:**

- `/new` or `/reset` on persistent sessions
- Creating session without a name
- Resetting main session when it's not the active session

## Troubleshooting

### Session not appearing in list

- Check gateway logs: `openclaw logs --follow`
- Verify session was created: Check `~/.openclaw/sessions-store.json`
- Restart gateway: `openclaw gateway restart`

### Reset command not blocked

- Verify session has `persistent: true` in store
- Check gateway version is updated
- Clear browser cache and reload

### UI not showing badge

- Hard refresh browser (Cmd+Shift+R / Ctrl+Shift+R)
- Check browser console for errors
- Verify UI was rebuilt: Check `dist/` directory timestamp

### Context not isolated

- Verify different sessionId in transcript files
- Check `~/.openclaw/transcripts/<sessionId>.jsonl`
- Each session should have its own transcript file

## Files to Inspect

Session store:

```bash
cat ~/.openclaw/sessions-store.json | jq
```

Transcript files:

```bash
ls -la ~/.openclaw/transcripts/
```

Gateway logs:

```bash
openclaw logs --follow
```

## Rollback

If issues occur:

```bash
cd ~/Documents/sourcecode/openclaw
git checkout main
npm run build
openclaw gateway restart
```

## Reporting Issues

If you find bugs, please include:

1. Steps to reproduce
2. Expected vs actual behavior
3. Gateway logs
4. Session store contents (sanitized)
5. Browser console errors (if UI issue)
