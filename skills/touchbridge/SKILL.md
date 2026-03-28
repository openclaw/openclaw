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
              "id": "source",
              "kind": "shell",
              "command": "git clone https://github.com/HMAKT99/UnTouchID.git /tmp/touchbridge-install && cd /tmp/touchbridge-install && cd daemon && swift build -c release && cd .. && make -C pam && sudo bash scripts/install.sh",
              "bins": ["touchbridged", "touchbridge-test"],
              "label": "Build and install from source (recommended)",
            },
            {
              "id": "pkg",
              "kind": "pkg",
              "url": "https://github.com/HMAKT99/UnTouchID/releases/download/v0.1.0-alpha/TouchBridge-0.1.0.pkg",
              "sha256": "370b8f0ab32c23216f16de19c8487633301be2810b9fa8793e3ac093f7699f9e",
              "bins": ["touchbridged", "touchbridge-test"],
              "label": "Install TouchBridge (.pkg) — verify with: shasum -a 256 TouchBridge-0.1.0.pkg",
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
2. If not installed: **build from source** (recommended — user can audit the code):
   ```bash
   git clone https://github.com/HMAKT99/UnTouchID.git
   cd UnTouchID && cd daemon && swift build -c release && cd ..
   make -C pam
   sudo bash scripts/install.sh
   ```
   Alternatively, download the .pkg from the GitHub release and verify its checksum:
   ```bash
   shasum -a 256 TouchBridge-0.1.0.pkg
   # Expected: 370b8f0ab32c23216f16de19c8487633301be2810b9fa8793e3ac093f7699f9e
   spctl -a -t install TouchBridge-0.1.0.pkg  # verify notarisation
   ```
3. Check daemon status: `ls ~/Library/Application\ Support/TouchBridge/daemon.sock`.
4. Start the daemon:
   - **Production** (requires paired phone): `touchbridged serve` or `touchbridged serve --web`
   - **Testing only** — ⚠️ REQUIRES EXPLICIT USER CONFIRMATION before running:
     `touchbridged serve --simulator`
     This mode auto-approves ALL sudo requests with no biometric check. Never use in production. Always ask the user before enabling this mode.

### For sudo commands

TouchBridge automatically handles `sudo` authentication when installed. The PAM module intercepts the auth request and routes it to the daemon, which prompts the user's phone.

If the phone is unreachable, sudo falls through to the normal password prompt — the user is never locked out.

### Modes

- `touchbridged serve` — production mode with paired iPhone/Android via BLE
- `touchbridged serve --web` — any phone via browser URL (no app install needed)
- `touchbridged serve --interactive` — approve/deny in terminal
- `touchbridged serve --simulator` — ⚠️ TESTING ONLY — auto-approves all sudo. Never enable without explicit user consent.

### Configuration

```bash
touchbridge-test config show              # view policy
touchbridge-test config set --timeout 20  # change auth timeout
touchbridge-test logs                     # view recent auth events
touchbridge-test list-devices             # show paired devices
```

## Guardrails

- **Never enable `--simulator` mode without explicit user confirmation.** This mode auto-approves all sudo requests and is a critical security risk if left running in production.
- Never type or log the user's macOS password — TouchBridge replaces password entry entirely.
- If `touchbridged` is not running, sudo falls through to password — never block the user.
- Never modify `/etc/pam.d/sudo` directly — use the install script which creates backups.
- When installing via .pkg, always verify the SHA-256 checksum before running.
- The build-from-source path is the recommended install method — users can audit the code before running it.
