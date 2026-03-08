#!/usr/bin/env bash
set -euo pipefail

# Local continuous-voice verification harness.
# Focus: talk/voice configuration + closed-loop voice-call path.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[voice-smoke] running talk config + closed-loop voice tests"
pnpm exec vitest run \
  src/config/talk.normalize.test.ts \
  src/config/config.talk-api-key-fallback.test.ts \
  src/gateway/server.talk-config.test.ts \
  src/gateway/server.models-voicewake-misc.test.ts \
  --maxWorkers=1

echo "[voice-smoke] running voice call closed-loop tests"
pnpm run -s test:voicecall:closedloop

echo "[voice-smoke] PASS"
