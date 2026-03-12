# OpenClaw Browser — Setup Details

## Config File

Set `browser.headless: false` in `~/.openclaw/openclaw.json`:

```json
{
  "browser": {
    "headless": false
  }
}
```

## Desktop Shortcut

Run `scripts/create-shortcut.ps1` to create a desktop shortcut:

```powershell
powershell -ExecutionPolicy Bypass -File <skill-dir>/scripts/create-shortcut.ps1
```

Shortcut args: `--remote-debugging-port=18800 --user-data-dir=<profile-path> --no-first-run --no-default-browser-check`

## Usage Methods

### Method A: Agent starts browser (preferred)

```
browser action=start profile=openclaw
browser action=open url=https://example.com profile=openclaw
```

With `headless: false`, the Chrome window appears on the user's monitor automatically.

### Method B: User starts via shortcut

User opens "OpenClaw Browser" shortcut → agent attaches via CDP on port 18800:

```
browser action=status profile=openclaw   # verify cdpReady=true
browser action=open url=https://example.com profile=openclaw
```

### Method C: Stop browser

```
browser action=stop profile=openclaw
```

## Key Details

| Item         | Value                                                                   |
| ------------ | ----------------------------------------------------------------------- |
| CDP Port     | 18800                                                                   |
| Profile data | `~/.openclaw/browser/openclaw/user-data`                                |
| Config key   | `browser.headless`                                                      |
| Executable   | System Chrome (`C:\Program Files\Google\Chrome\Application\chrome.exe`) |

## Important Notes

- **One instance at a time.** Agent `browser start` and desktop shortcut use the same CDP port (18800). Don't run both simultaneously.
- **Separate login sessions.** This browser has its own profile — site logins are independent from the user's main Chrome.
- **No Relay needed.** This is NOT the Chrome Extension Relay. It's a standalone managed instance.
