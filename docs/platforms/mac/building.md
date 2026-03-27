---
summary: "Build OpenClaw macOS app for specific architectures or as Universal binaries"
read_when:
  - Building OpenClaw macOS app for a specific architecture
  - Creating Universal binaries for distribution
title: "macOS Cross-Architecture Builds"
---

# macOS Cross-Architecture Builds

OpenClaw supports building the macOS app for different architectures. This guide explains how to build for Apple Silicon (arm64), Intel (x86_64), or as Universal binaries (both architectures in one package).

## Architecture Overview

- **Apple Silicon (arm64)**: Native on M1/M2/M3/M4 Macs
- **Intel (x86_64)**: Native on Intel-based Macs
- **Universal Binary**: Single app bundle containing both arm64 and x86_64 code, runs natively on all Macs

## Default Build Behavior

The packaging script (`scripts/package-mac-app.sh`) has sensible defaults:

| Build Mode                       | Default Architecture         | When To Use                       |
| -------------------------------- | ---------------------------- | --------------------------------- |
| Release (`BUILD_CONFIG=release`) | Universal                    | Production releases, distribution |
| Debug (`BUILD_CONFIG=debug`)     | Current machine (`uname -m`) | Development, testing              |

## Quick Start

### Default Build

```bash
# Build release (Universal binary)
./scripts/package-mac-app.sh

# Build debug (current architecture only)
BUILD_CONFIG=debug ./scripts/package-mac-app.sh
```

### Build for Specific Architectures

Use the `BUILD_ARCHS` environment variable to control which architectures to build:

```bash
# Intel-only build (useful from Apple Silicon to test Intel compatibility)
BUILD_ARCHS="x86_64" ./scripts/package-mac-app.sh

# Apple Silicon-only build (useful from Intel Mac to test ARM compatibility)
BUILD_ARCHS="arm64" ./scripts/package-mac-app.sh

# Universal debug build (both architectures, dev mode)
BUILD_ARCHS="arm64 x86_64" BUILD_CONFIG=debug ./scripts/package-mac-app.sh
```

## Common Scenarios

### Building Intel-Only from Apple Silicon

If you need an Intel-only version (e.g., for a specific Intel Mac without Rosetta 2):

```bash
BUILD_ARCHS="x86_64" ./scripts/package-mac-app.sh
```

**Note**: This requires an appropriate Xcode cross-compilation setup. The Swift compiler will target x86_64 from your arm64 host.

### Building Universal from Apple Silicon

The standard release build is already Universal. For a Universal debug build:

```bash
BUILD_ARCHS="arm64 x86_64" BUILD_CONFIG=debug ./scripts/package-mac-app.sh
```

### Testing Both Architectures

To verify your app works on both architectures:

1. Build Universal binary: `./scripts/package-mac-app.sh`
2. Verify architecture with: `file dist/OpenClaw.app/Contents/MacOS/OpenClaw`
3. Expected output shows both architectures:
   ```
   dist/OpenClaw.app/Contents/MacOS/OpenClaw: Mach-O universal binary with 2 architectures
   ```

### Building Without Rosetta 2

Even without Rosetta installed on Apple Silicon, you can build Intel versions:

```bash
BUILD_ARCHS="x86_64" ./scripts/package-mac-app.sh
```

The resulting app will run on Intel Macs natively, and on Apple Silicon Macs via Rosetta 2 (if installed).

## Technical Details

### Build Process

The packaging script:

1. Builds separate Swift binaries for each architecture using `swift build --arch <arch>`
2. Merges binaries using `/usr/bin/lipo -create` if multiple architectures
3. Handles framework merging (e.g., Sparkle.framework) across architectures
4. Creates a single `.app` bundle

### Framework Merging

For Universal builds containing frameworks (like Sparkle), the script:

1. Compiles frameworks for each architecture
2. Merges Mach-O files within the framework using `lipo`
3. Ensures the final framework contains both arm64 and x86_64 code

### Binary Verification

Verify the architecture of your build:

```bash
# Check the main binary
file dist/OpenClaw.app/Contents/MacOS/OpenClaw

# Check for specific architectures
lipo -info dist/OpenClaw.app/Contents/MacOS/OpenClaw

# List all architectures in the binary
lipo -archs dist/OpenClaw.app/Contents/MacOS/OpenClaw
```

## Performance Considerations

- **Universal binaries** are larger (~2x size) but provide best compatibility
- **Single-architecture builds** are smaller and faster to compile
- For development: use current architecture (`BUILD_CONFIG=debug`)
- For distribution: use Universal (`BUILD_CONFIG=release`)

## Related Documentation

- [Release artifacts & CPU architectures](/platforms/mac/release-artifacts-and-architectures) - What stable releases ship (Universal vs per-arch zips), `lipo` verification
- [macOS Dev Setup](/platforms/mac/dev-setup) - General macOS development setup
- [macOS Signing](/platforms/mac/signing) - Code signing for macOS builds
