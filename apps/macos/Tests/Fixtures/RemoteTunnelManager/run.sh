#!/bin/bash
# Headless owner regression: no SSH, PortGuardian ledger, defaults, or live services.
set -euo pipefail

fixture_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$fixture_source/../../../../.." && pwd)"
fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-remote-tunnel.XXXXXX")"
trap 'rm -rf -- "$fixture_dir"' EXIT

xcrun swiftc -swift-version 6 -parse-as-library \
  "$repo_root/apps/macos/Sources/OpenClaw/RemoteTunnelManager.swift" \
  "$fixture_source/Fixture.swift" \
  -o "$fixture_dir/remote-tunnel-tests"
"$fixture_dir/remote-tunnel-tests"
