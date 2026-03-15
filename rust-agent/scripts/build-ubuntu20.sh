#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo not found. Install Rust via rustup first." >&2
  exit 1
fi

echo "[openclaw-rs] building release binary for Ubuntu 20.04 compatible GNU target"
rustup toolchain install 1.83.0
rustup component add clippy rustfmt --toolchain 1.83.0

cargo +1.83.0 build --release

echo "[openclaw-rs] built: $ROOT_DIR/target/release/openclaw-agent-rs"
