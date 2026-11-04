#!/bin/bash
# Headless owner regression: no app, AppKit, defaults, Keychain, or live services.
set -euo pipefail

fixture_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$fixture_source/../../../../.." && pwd)"
fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-connection-mode.XXXXXX")"
trap 'rm -rf -- "$fixture_dir"' EXIT

xcrun swiftc -swift-version 6 -parse-as-library \
  "$repo_root/apps/macos/Sources/OpenClaw/ConnectionModeCoordinator.swift" \
  "$repo_root/apps/macos/Sources/OpenClaw/GatewayAutostartPolicy.swift" \
  "$fixture_source/Fixture.swift" \
  -o "$fixture_dir/connection-mode-tests"
"$fixture_dir/connection-mode-tests"
