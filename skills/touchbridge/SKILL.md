---
name: touchbridge
description: Authenticate sudo and macOS system prompts using your phone's biometric (Face ID/fingerprint) instead of typing passwords. Perfect for Mac Mini, Mac Studio, Mac Pro, and MacBook Neo base users without Touch ID.
homepage: https://github.com/HMAKT99/UnTouchID
metadata:
  {
    "openclaw":
      {
        "emoji": "🔐",
        "requires": { "bins": ["touchbridged", "touchbridge-test"] },
        "install":
          [
            {
              "id": "pkg",
              "kind": "pkg",
              "url": "https://github.com/HMAKT99/UnTouchID/releases/download/v0.1.0-alpha/TouchBridge-0.1.0.pkg",
              "bins": ["touchbridged", "touchbridge-test"],
              "label": "Install TouchBridge (.pkg)",
            },
          ],
      },
  }
---

# TouchBridge

Use your phone's fingerprint or Face ID to authenticate `sudo`, screensaver unlock, and other macOS auth prompts — instead of typing your password.

Free, open source alternative to Apple's $199 Touch ID keyboard. Works with iPhone, Android, Apple Watch, Wear OS, or any browser.

## References

- `references/setup.md` (install + pairing + testing)

## Workflow

1. Check if TouchBridge is installed: `which touchbridged`.
2. If not installed: download and run the .pkg installer from the GitHub release.
3. Check daemon status: `ls ~/Library/Application\ Support/TouchBridge/daemon.sock`.
4. If daemon not running: `touchbridged serve --simulator` (for testing) or `touchbridged serve --web` (for phone auth).

### For sudo commands

TouchBridge automatically handles `sudo` authentication when installed. The PAM module intercepts the auth request and routes it to the daemon, which prompts the user's phone.

If the phone is unreachable, sudo falls through to the normal password prompt — the user is never locked out.

### Modes

- `touchbridged serve --simulator` — auto-approve (testing, no phone needed)
- `touchbridged serve --web` — any phone via browser URL (no app install)
- `touchbridged serve --interactive` — approve/deny in terminal
- `touchbridged serve` — production mode with paired iPhone/Android via BLE

### Configuration

```bash
touchbridge-test config show              # view policy
touchbridge-test config set --timeout 20  # change auth timeout
touchbridge-test logs                     # view recent auth events
touchbridge-test list-devices             # show paired devices
```

## Guardrails

- Never type or log the user's macOS password — TouchBridge replaces password entry entirely.
- If `touchbridged` is not running, sudo falls through to password — never block the user.
- The simulator mode (`--simulator`) is for testing only — remind the user to switch to phone auth for real security.
- Never modify `/etc/pam.d/sudo` directly — use the install script which creates backups.
