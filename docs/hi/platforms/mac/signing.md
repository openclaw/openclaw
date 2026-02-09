---
summary: "पैकेजिंग स्क्रिप्ट्स द्वारा उत्पन्न macOS डिबग बिल्ड्स के लिए साइनिंग चरण"
read_when:
  - mac डिबग बिल्ड्स का निर्माण या साइनिंग करते समय
title: "macOS साइनिंग"
---

# mac साइनिंग (डिबग बिल्ड्स)

यह ऐप आम तौर पर [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) से बनाया जाता है, जो अब:

- एक स्थिर डिबग बंडल आइडेंटिफ़ायर सेट करता है: `ai.openclaw.mac.debug`
- उसी बंडल आईडी के साथ Info.plist लिखता है ( `BUNDLE_ID=...` के माध्यम से ओवरराइड करें)
- calls [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) to sign the main binary and app bundle so macOS treats each rebuild as the same signed bundle and keeps TCC permissions (notifications, accessibility, screen recording, mic, speech). For stable permissions, use a real signing identity; ad-hoc is opt-in and fragile (see [macOS permissions](/platforms/mac/permissions)).
- uses `CODESIGN_TIMESTAMP=auto` by default; it enables trusted timestamps for Developer ID signatures. Set `CODESIGN_TIMESTAMP=off` to skip timestamping (offline debug builds).
- Info.plist में बिल्ड मेटाडेटा इंजेक्ट करता है: `OpenClawBuildTimestamp` (UTC) और `OpenClawGitCommit` (शॉर्ट हैश), ताकि About पैन बिल्ड, git, और डिबग/रिलीज़ चैनल दिखा सके।
- **पैकेजिंग के लिए Node 22+ आवश्यक है**: स्क्रिप्ट TS बिल्ड्स और Control UI बिल्ड चलाती है।
- reads `SIGN_IDENTITY` from the environment. Add `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (or your Developer ID Application cert) to your shell rc to always sign with your cert. Ad-hoc signing requires explicit opt-in via `ALLOW_ADHOC_SIGNING=1` or `SIGN_IDENTITY="-"` (not recommended for permission testing).
- runs a Team ID audit after signing and fails if any Mach-O inside the app bundle is signed by a different Team ID. Set `SKIP_TEAM_ID_CHECK=1` to bypass.

## उपयोग

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### Ad-hoc साइनिंग नोट

When signing with `SIGN_IDENTITY="-"` (ad-hoc), the script automatically disables the **Hardened Runtime** (`--options runtime`). This is necessary to prevent crashes when the app attempts to load embedded frameworks (like Sparkle) that do not share the same Team ID. Ad-hoc signatures also break TCC permission persistence; see [macOS permissions](/platforms/mac/permissions) for recovery steps.

## About के लिए बिल्ड मेटाडेटा

`package-mac-app.sh` बंडल पर निम्न मुहर लगाता है:

- `OpenClawBuildTimestamp`: पैकेज समय पर ISO8601 UTC
- `OpenClawGitCommit`: शॉर्ट git हैश (या अनुपलब्ध होने पर `unknown`)

The About tab reads these keys to show version, build date, git commit, and whether it’s a debug build (via `#if DEBUG`). Run the packager to refresh these values after code changes.

## क्यों

TCC permissions are tied to the bundle identifier _and_ code signature. Unsigned debug builds with changing UUIDs were causing macOS to forget grants after each rebuild. Signing the binaries (ad‑hoc by default) and keeping a fixed bundle id/path (`dist/OpenClaw.app`) preserves the grants between builds, matching the VibeTunnel approach.
