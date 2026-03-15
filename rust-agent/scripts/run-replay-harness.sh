#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[openclaw-rs] running replay sidecar integration harness"
cargo test replay_harness_with_real_defender -- --nocapture
