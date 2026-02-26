#!/usr/bin/env bash
set -euo pipefail

# OpenClaw Android UX smoke test helper (operator-guided)
# - Builds/install app
# - Launches app
# - Prints concise manual verification checklist

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -z "${JAVA_HOME:-}" && -x /opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home/bin/java ]]; then
  export JAVA_HOME="/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home"
  export PATH="$JAVA_HOME/bin:$PATH"
fi

if ! command -v adb >/dev/null 2>&1; then
  echo "❌ adb not found. Install Android platform-tools and try again."
  exit 1
fi

echo "==> Checking connected Android devices"
adb devices -l

DEVICE_COUNT="$(adb devices -l | awk 'NR>1 && /(^|[[:space:]])device([[:space:]]|$)/ {count++} END {print count+0}')"
if [[ "$DEVICE_COUNT" -lt 1 ]]; then
  echo "❌ No authorized device found. Connect phone/emulator and accept USB debug prompt."
  exit 1
fi

echo "==> Building + installing debug APK"
./gradlew :app:installDebug -q

echo "==> Launching app"
adb shell am start -n ai.openclaw.android/.MainActivity >/dev/null

cat <<'EOF'

✅ App launched. Run this 5-minute smoke checklist:

[1] Onboarding flow
  - Confirm 4-step flow appears and navigation works (Back/Next).
  - Gateway step: QR button visible + Advanced panel expandable.
  - Permissions step copy says mic/camera/SMS are requested on first use.

[2] Connect flow
  - Enter setup code or manual endpoint and connect.
  - Status reaches connected; if pairing needed, approve via:
      openclaw nodes pending
      openclaw nodes approve <requestId>

[3] Chat UX
  - Send a prompt and verify streaming appears smoothly (no jitter bursts).
  - During network interruption, status pill shows Connecting/Reconnecting.
  - Trigger an error and verify Retry button appears and works.

[4] First-use permission explainers
  - Trigger camera.snap -> camera permission prompt should mention camera capture.
  - Trigger screen/camera audio path -> mic prompt should mention recording audio context.
  - Trigger SMS send -> prompt should mention sending SMS.

[5] Regression sanity
  - Re-open Connect tab and confirm advanced controls still work.
  - Verify no crashes when switching tabs during/after chat stream.

Tip: capture logs during testing:
  adb logcat | grep -i "openclaw\|PermissionRequester\|ChatController"

EOF
