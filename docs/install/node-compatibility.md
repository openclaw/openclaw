---
summary: "Supported Node.js versions, SQLite requirements, platform limits, and release history"
title: "Node.js compatibility"
read_when:
  - You need to check which Node.js versions OpenClaw supports
  - You want to understand a Node.js minimum version or platform support change
---

This reference covers supported Node.js lines, why the minimum versions exist, and how they changed across OpenClaw releases. For installation steps, see [Node.js](/install/node); for macOS companion app requirements, see [macOS](/platforms/macos).

## Supported versions

| Line    | Status      | Minimum         | Notes                                                     |
| ------- | ----------- | --------------- | --------------------------------------------------------- |
| Node 26 | Recommended | `>=26.1.0`      | Faster Gateway startup and lower memory use than Node 24. |
| Node 24 | Supported   | `>=24.16.0 <25` | LTS line used by CI and the Linux installer.              |
| Node 25 | Unsupported | —               | Excluded by the current TEXT decoder floor.               |
| Node 23 | Unsupported | —               | Excluded earlier for incompatible `node:sqlite` behavior. |
| Node 22 | Unsupported | —               | Unsupported since the 24.16.0/26.1.0 floor.               |

The exact engines expression is `>=24.16.0 <25 || >=26.1.0`. It is enforced by `package.json` engines during npm installation, the startup runtime guard for every `openclaw` command, and the installer scripts.

## Why the floors exist

The **SQLite WAL-reset corruption bug** requires a safe loaded library: SQLite **3.51.3+**, **3.50.7+ within 3.50.x**, or **3.44.6+ within 3.44.x**. OpenClaw validates the library actually loaded because Node builds linked to shared system SQLite can use a different version from Node's own metadata.

Separately, the **`node:sqlite` TEXT decoder** in Node 22.23.x, 24.15.0, 25.9.0, and 26.0.0 silently truncates values at embedded NUL characters. The first fixed releases are Node 24.16.0 and 26.1.0; a WAL-safe SQLite library does not fix this decoder. Node 23 was excluded earlier for incompatible `node:sqlite` behavior.

## Platform consequences

Official Node 24+ binaries require **macOS 13.5+**, so macOS 11 through 13.4 no longer support the Node-based CLI or Gateway. The companion app has separate [macOS requirements](/platforms/macos).

Supported Node lines have no official **Linux ARMv7** builds. Use a 64-bit operating system on compatible ARM hardware, or another supported host.

On RPM-based distributions, the installer preserves a supported distro-owned Node package that links unsafe system SQLite and provisions a separate user-space runtime for OpenClaw.

## What the installer provisions

Recommended, supported, and provisioned are three different things.

| Platform        | Installer path                              | Node provisioned                                                                           |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Linux           | `install.sh`: apt/dnf/yum via NodeSource    | Node 24.x LTS.                                                                             |
| Linux and macOS | Rootless `install-cli.sh`                   | Node 24.19.0 by default; existing runtime reuse and explicit version selection can differ. |
| macOS           | `install.sh`: Homebrew `node`               | Node 26; no exact patch pinned, and an existing supported Node can be retained.            |
| Windows         | `install.ps1`: Chocolatey, Scoop, or winget | LTS package; no exact patch pinned, validated after installation.                          |
| Windows         | `install.ps1`: portable fallback            | Latest 26.x Windows zip.                                                                   |

See [Installer internals](/install/installer) for provisioning details.

## Check your runtime

```bash
node -v
```

Upgrade Node before updating OpenClaw if your version is unsupported. The startup guard prints this requirement sentence:

> `openclaw requires Node >=24.16.0 <25, or >=26.1.0.`

## History across releases

Rows identify the first effective release, including a beta when applicable. Recommendation and installer changes are listed even when the numeric requirement stayed the same.

| Release                              | Node requirement                                 | What changed and why                                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unreleased (main)                    | `>=24.16.0 <25 \|\| >=26.1.0`                    | Raises the Node 24 floor and drops Node 22 and 25 to prevent embedded-NUL TEXT truncation; Node 23 remains excluded. Official Node-based support for macOS 11–13.4 and Linux ARMv7 provisioning ends. #140672 |
| v2026.8.2                            | `>=22.22.3 <23 \|\| >=24.15.0 <25 \|\| >=25.9.0` | Preserves supported RPM-owned Node packages with unsafe system SQLite and provisions a separate user-space runtime. The numeric range and loaded-library safety requirement stay unchanged. #134166           |
| v2026.8.1                            | `>=22.22.3 <23 \|\| >=24.15.0 <25 \|\| >=25.9.0` | Rootless defaults advance to 24.19.0, or 22.23.2 on ARMv7. Linux package provisioning returns to Node 24 LTS to avoid prerelease repository builds. #130369                                                   |
| v2026.8.1-beta.3; stable v2026.8.1   | `>=22.22.3 <23 \|\| >=24.15.0 <25 \|\| >=25.9.0` | Centralizes release classification in `node-version.mjs`, rejecting prerelease, nightly, and malformed version labels. #124812                                                                                |
| v2026.7.2-beta.5; stable v2026.8.1   | `>=22.22.3 <23 \|\| >=24.15.0 <25 \|\| >=25.9.0` | Recommends Node 26 for faster Gateway startup and lower memory use than Node 24. CI and release workflows retain Node 24. #114399                                                                             |
| v2026.7.1; main v2026.7.2-beta.1     | `>=22.22.3 <23 \|\| >=24.15.0 <25 \|\| >=25.9.0` | Requires builds carrying the SQLite WAL-reset fix, validates the actual loaded SQLite library, and excludes all Node 23. Shipped through a release cherry-pick. #106065                                       |
| v2026.7.1-beta.2                     | `>=22.19.0 <23 \|\| >=23.11.0`                   | Excludes Node 23.0–23.10 for incompatible SQLite behavior in the dialect's `StatementSync.columns()` path. Superseded before stable v2026.7.1. #99832                                                         |
| v2026.5.16-beta.7; stable v2026.5.18 | `>=22.19.0`                                      | Raises the floor with the Pi dependencies' update to 0.75.1. Node 24 remains recommended.                                                                                                                     |
| v2026.5.9-beta.1; stable v2026.5.12  | `>=22.16.0`                                      | Raises the floor for the native SQLite Kysely dialect's use of `StatementSync.columns()` to identify result-producing statements. #78921                                                                      |
| v2026.3.24-beta.2; stable v2026.3.24 | `>=22.14.0`                                      | Lowers the floor from 22.16 so npm installs and self-updates do not strand existing Node 22.14 users.                                                                                                         |
| v2026.3.12                           | `>=22.16.0`                                      | Raises the floor from 22.12 and makes Node 24 the default/recommended line for installs, CI, and releases. The recorded change does not identify a specific missing API.                                      |
| v2026.2.6                            | `>=22.12.0`                                      | Aligns the startup guard with the package requirement because Matrix's SDK requires 22.12 and older runtimes produce misleading module-not-found errors. #5370                                                |
| v2026.1.5 (earlier v2.0.0-beta3)     | Package `>=22.12.0`; startup `>=22.0.0`          | Raises the package floor from 22.0 to 22.12 without a recorded API-specific reason. Startup validation temporarily retains the older minimum.                                                                 |
| Before 2026                          | `>=22.0.0`                                       | The earliest package engine declaration requires Node 22; no narrower runtime-feature justification is recorded.                                                                                              |

## Related

- [Bun compatibility](/install/bun-compatibility)
- [Installer internals](/install/installer)
- [Linux](/platforms/linux)
- [macOS](/platforms/macos)
- [Node.js](/install/node)
