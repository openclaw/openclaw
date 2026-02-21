#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[openclaw-rs] running protocol corpus snapshot checks"
cargo test protocol_corpus_snapshot_matches_expectations -- --nocapture
