---
summary: "Maintainer macOS release procedure lives in the private maintainer repo"
read_when:
  - Looking for the maintainer macOS release procedure
  - Tracing macOS release packaging in this repo
title: "macOS Release"
---

# OpenClaw macOS release

The macOS release procedure lives in the private `openclaw/maintainers` repo.
This public repo keeps the packaging scripts and appcast source, but not the
maintainer runbook.

Maintainers: use the private release manual:

- [`release/README.md`](https://github.com/openclaw/maintainers/blob/main/release/README.md)

Public code and asset references in this repo:

- [`scripts/package-mac-dist.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-dist.sh)
- [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh)
- [`scripts/create-dmg.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/create-dmg.sh)
- [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)
- [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)
- [`apps/macos/Sources/OpenClaw/Resources/Info.plist`](https://github.com/openclaw/openclaw/blob/main/apps/macos/Sources/OpenClaw/Resources/Info.plist)
- [`appcast.xml`](https://github.com/openclaw/openclaw/blob/main/appcast.xml)

Signing material, Sparkle keys, notarization credentials, GitHub release steps,
and operator verification stay in the maintainer repo.
