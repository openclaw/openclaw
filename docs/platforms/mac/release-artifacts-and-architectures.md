---
summary: "What architectures ship in official macOS builds, how to verify, and how maintainers produce thin (per-CPU) zips"
read_when:
  - Users ask for Intel (x86_64) or Universal Binary downloads
  - Triaging GitHub issues about macOS CPU architecture
  - Release engineering for macOS .zip / .dmg assets
title: "macOS release artifacts & CPU architectures"
---

# macOS release artifacts & CPU architectures

## For users (Intel / Apple Silicon)

**Stable macOS app releases are intended to ship as a single Universal Binary**: one `OpenClaw.app` whose main executable contains **both** `arm64` (Apple Silicon) and `x86_64` (Intel). You do **not** need a separate “Intel build” for normal installs—download the standard release from [GitHub Releases](https://github.com/openclaw/openclaw/releases).

### Verify locally

After installing or unpacking the app:

```bash
file dist/OpenClaw.app/Contents/MacOS/OpenClaw
# Expect: Mach-O universal binary with 2 architectures: [x86_64:arm64] (order may vary)

lipo -archs dist/OpenClaw.app/Contents/MacOS/OpenClaw
# Expect: arm64 x86_64 (order may vary)
```

If you only see one architecture, that build may be a **single-arch** artifact (debug build, custom packaging, or an intermediate)—compare with the [development channels](/install/development-channels) notes for that release.

### Smaller downloads (optional)

Release packaging can also emit **per-architecture zips** (`OpenClaw-<version>-arm64.zip`, `OpenClaw-<version>-x86_64.zip`) when `PER_ARCH_DIST=1` is set during `scripts/package-mac-dist.sh`. That is optional and usually for bandwidth-sensitive users; the default Universal `.zip` / `.dmg` remains the primary artifact.

---

## For maintainers & contributors

| Piece                                                                                                                       | Role                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh)                   | Builds `OpenClaw.app`; **release** defaults to `BUILD_ARCHS=all` → `arm64 x86_64`.                                                                                               |
| [`scripts/package-mac-dist.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-dist.sh)                 | Wraps the app script, then zips/DMG; defaults `BUILD_ARCHS=all`; enforces Universal on **release** when `BUILD_ARCHS=all`.                                                       |
| `PER_ARCH_DIST=1`                                                                                                           | When `BUILD_ARCHS=all`, also produces thin zips via `lipo -thin`.                                                                                                                |
| [`.github/workflows/macos-release.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/macos-release.yml) | **Validation-only** on the public repo: checks scripts still default to Universal; **signing/notarization/upload** runs in the private release workflow referenced in that file. |

### Build Intel-only or Universal from source

See [Cross-architecture builds](/platforms/mac/building). Quick examples:

```bash
# Intel-only (e.g. test on Intel without caring about arm64 slice)
BUILD_ARCHS="x86_64" ./scripts/package-mac-app.sh

# Universal release (default when BUILD_CONFIG=release)
./scripts/package-mac-dist.sh
```

---

## Related

- [macOS App overview](/platforms/macos) — requirements and feature list
- [Development channels](/install/development-channels) — stable channel + macOS app notes
- [Cross-architecture builds](/platforms/mac/building) — `BUILD_ARCHS` reference
