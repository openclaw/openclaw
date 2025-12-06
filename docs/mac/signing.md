# mac signing (debug builds)

This app is usually built from `scripts/package-mac-app.sh`, which now:

- sets a stable debug bundle identifier: `com.steipete.clawdis.debug`
- writes the Info.plist with that bundle id (override via `BUNDLE_ID=...`)
- ad‑hoc signs the main binary, the bundled CLI, and the app bundle so macOS treats each rebuild as the same signed bundle and keeps TCC permissions (notifications, accessibility, screen recording, mic, speech)

## Usage

```bash
# from repo root
scripts/package-mac-app.sh
```

If you need a different bundle id (e.g. release build):

```bash
BUNDLE_ID=com.steipete.clawdis scripts/package-mac-app.sh
```

## Why

TCC permissions are tied to the bundle identifier *and* code signature. Unsigned debug builds with changing UUIDs were causing macOS to forget grants after each rebuild. Ad‑hoc signing the binaries and keeping a fixed bundle id/path (`dist/Clawdis.app`) preserves the grants between builds, matching the VibeTunnel approach.
