---
summary: "macOS permission persistence (TCC) and signing requirements"
read_when:
  - Debugging missing or stuck macOS permission prompts
  - Packaging or signing the macOS app
  - Changing bundle IDs or app install paths
title: "macOS Permissions"
---

# macOS permissions (TCC)

macOS permission grants are fragile. TCC associates a permission grant with the
app's code signature, bundle identifier, and on-disk path. If any of those change,
macOS treats the app as new and may drop or hide prompts.

## Requirements for stable permissions

- Same path: run the app from a fixed location (for OpenClaw, `dist/OpenClaw.app`).
- Same bundle identifier: changing the bundle ID creates a new permission identity.
- Signed app: unsigned or ad-hoc signed builds do not persist permissions.
- Consistent signature: use a real Apple Development or Developer ID certificate
  so the signature stays stable across rebuilds.

Ad-hoc signatures generate a new identity every build. macOS will forget previous
grants, and prompts can disappear entirely until the stale entries are cleared.

## Personal data permissions

Calendar, Reminders, and Contacts require two things at the same time:

- app entitlements at code-sign time
- `Info.plist` usage-description keys

If either is missing, TCC can deny access even when you toggled permission in Settings.

OpenClaw mac app permissions are provided by:

- entitlements in [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh):
  - `com.apple.security.personal-information.calendars`
  - `com.apple.security.personal-information.reminders`
  - `com.apple.security.personal-information.addressbook`
- usage strings in `apps/macos/Sources/OpenClaw/Resources/Info.plist`:
  - `NSCalendarsUsageDescription`
  - `NSRemindersUsageDescription`
  - `NSRemindersFullAccessUsageDescription`
  - `NSContactsUsageDescription`

TCC symptom mapping:

- `requires entitlement ... but it is missing`: signing entitlements are missing or stale on the built app.
- `missing usage string`: the corresponding `NS*UsageDescription` key is missing in `Info.plist`.

## Recovery checklist when prompts disappear

1. Quit the app.
2. Remove the app entry in System Settings -> Privacy & Security.
3. Relaunch the app from the same path and re-grant permissions.
4. If the prompt still does not appear, reset TCC entries with `tccutil` and try again.
5. Some permissions only reappear after a full macOS restart.

Example resets (replace bundle ID as needed):

```bash
sudo tccutil reset Accessibility bot.molt.mac
sudo tccutil reset ScreenCapture bot.molt.mac
sudo tccutil reset AppleEvents
```

## Files and folders permissions (Desktop/Documents/Downloads)

macOS may also gate Desktop, Documents, and Downloads for terminal/background processes. If file reads or directory listings hang, grant access to the same process context that performs file operations (for example Terminal/iTerm, LaunchAgent-launched app, or SSH process).

Workaround: move files into the OpenClaw workspace (`~/.openclaw/workspace`) if you want to avoid per-folder grants.

If you are testing permissions, always sign with a real certificate. Ad-hoc
builds are only acceptable for quick local runs where permissions do not matter.
