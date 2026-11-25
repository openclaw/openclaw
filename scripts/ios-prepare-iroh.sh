#!/usr/bin/env bash
# Builds the iroh XCFramework when the opt-in native OpenClaw ID build is requested
# (OPENCLAW_IROH_NATIVE=1). Default builds do nothing here and never resolve the package.
set -euo pipefail

if [[ "${OPENCLAW_IROH_NATIVE:-0}" != "1" ]]; then
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Same pin as the iroh-ffi and apple-node-native workflows.
toolchain="${RUSTUP_TOOLCHAIN:-1.99.0}"
export PATH="$PATH:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin"
if ! command -v rustup >/dev/null; then
  echo "OPENCLAW_IROH_NATIVE=1 needs rustup. Install it, then: rustup toolchain install $toolchain --target aarch64-apple-darwin,x86_64-apple-darwin,aarch64-apple-ios,aarch64-apple-ios-sim,x86_64-apple-ios" >&2
  exit 1
fi

# rustup run puts the pinned toolchain's cargo first, so a Homebrew cargo on PATH cannot shadow it.
# The XCFramework keeps its macOS slice: the Mac app shares this artifact.
cd "$ROOT_DIR/crates/openclaw-iroh-ffi"
rustup run "$toolchain" scripts/build-apple.sh
