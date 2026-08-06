#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/live-smoke.sh [--test-audio] [--hangup]

Runs the non-calling FaceTime readiness checks, then prints current status.
If --test-audio is passed, sends the configured test phrase through the active
FaceTime call. If --hangup is passed, hangs up the active FaceTime call.
EOF
}

test_audio=false
hangup=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --test-audio)
      test_audio=true
      shift
      ;;
    --hangup)
      hangup=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

echo "== FaceTime preflight =="
preflight_json="$(openclaw gateway call facetime.preflight --json --timeout 20000)"
printf '%s\n' "$preflight_json"
node -e '
  const fs = require("node:fs");
  const preflight = JSON.parse(fs.readFileSync(0, "utf8"));
  if (preflight && preflight.ok === true) {
    process.exit(0);
  }
  const failed = Array.isArray(preflight.checks)
    ? preflight.checks
        .filter((check) => check && check.required !== false && check.ok !== true)
        .map((check) => `${check.id || "unknown"}: ${check.message || "failed"}`)
    : [];
  console.error(`Preflight failed${failed.length ? `: ${failed.join("; ")}` : "."}`);
  process.exit(1);
' <<<"$preflight_json"

echo
echo "== FaceTime status =="
status_json="$(openclaw gateway call facetime.status --json --timeout 10000)"
printf '%s\n' "$status_json"
node -e '
  const fs = require("node:fs");
  const status = JSON.parse(fs.readFileSync(0, "utf8"));
  if (status && status.enabled === true && typeof status.helperConnected === "boolean") {
    process.exit(0);
  }
  console.error("facetime.status did not return the expected plugin status shape");
  process.exit(1);
' <<<"$status_json"

if [[ "$test_audio" == true ]]; then
  if ! node -e 'const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync(0,"utf8")); process.exit(Array.isArray(s.calls) && s.calls.length > 0 ? 0 : 1)' <<<"$status_json"; then
    echo "Refusing --test-audio because facetime.status has no active calls." >&2
    exit 1
  fi

  echo
  echo "== FaceTime test audio =="
  openclaw gateway call facetime.testAudio \
    --params '{"phrase":"This is OpenClaw speaking through FaceTime."}' \
    --json \
    --timeout 30000

  echo
  echo "== FaceTime status after test audio =="
  openclaw gateway call facetime.status --json --timeout 10000
fi

if [[ "$hangup" == true ]]; then
  echo
  echo "== FaceTime hangup =="
  openclaw gateway call facetime.hangup --json --timeout 10000

  echo
  echo "== FaceTime status after hangup =="
  openclaw gateway call facetime.status --json --timeout 10000
fi

echo
echo "== FaceTime bridge processes =="
pgrep -fl 'facetime-audio-capture|sox.*OpenClaw-Feed|caffeinate -d -i -w' || true
