---
title: "Release Checklist"
summary: "Maintainer release procedure lives in the private maintainer repo"
read_when:
  - Looking for the maintainer release procedure
  - Tracing release automation in this repo
---

# Release Checklist (npm + macOS)

OpenClaw release procedure is maintained in the private `openclaw/maintainers`
repo. This public repo keeps the workflows and scripts, but not the maintainer
runbook.

Maintainers: use the private release manual:

- [`release/README.md`](https://github.com/openclaw/maintainers/blob/main/release/README.md)

Public code and automation references in this repo:

- [`.github/workflows/openclaw-npm-release.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/openclaw-npm-release.yml)
- [`scripts/openclaw-npm-release-check.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/openclaw-npm-release-check.ts)
- [`scripts/openclaw-npm-publish.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/openclaw-npm-publish.sh)
- [`scripts/release-check.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/release-check.ts)
- [`scripts/package-mac-dist.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-dist.sh)
- [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh)
- [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)
- [`appcast.xml`](https://github.com/openclaw/openclaw/blob/main/appcast.xml)

Approvals, credentials, recovery notes, and the actual release steps stay in
the maintainer repo.
