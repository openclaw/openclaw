#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/android-screenshots.sh [--device <adb-serial>] [--locale en-US] [--skip-build] [--skip-install] [--dry-run]

Builds and installs the Play debug app, launches deterministic screenshot scenes,
and writes raw Google Play screenshots under:
  apps/android/fastlane/metadata/android/<locale>/images/phoneScreenshots/
EOF
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="${ROOT_DIR}/apps/android"
LOCALE="en-US"
DEVICE="${ANDROID_SCREENSHOT_DEVICE:-}"
SKIP_BUILD=0
SKIP_INSTALL=0
DRY_RUN=0
SCENES=(connect chat voice screen settings)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --device)
      DEVICE="${2:-}"
      shift 2
      ;;
    --locale)
      LOCALE="${2:-}"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --skip-install)
      SKIP_INSTALL=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

adb_bin() {
  if [[ -n "${ADB:-}" ]]; then
    printf '%s\n' "$ADB"
    return
  fi
  if command -v adb >/dev/null 2>&1; then
    command -v adb
    return
  fi
  for sdk_root in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Library/Android/sdk"; do
    if [[ -n "$sdk_root" && -x "$sdk_root/platform-tools/adb" ]]; then
      printf '%s\n' "$sdk_root/platform-tools/adb"
      return
    fi
  done
  echo "adb not found. Install Android platform-tools or set ADB." >&2
  return 127
}

resolve_device() {
  local adb="$1"
  if [[ -n "$DEVICE" ]]; then
    printf '%s\n' "$DEVICE"
    return
  fi
  local devices
  devices="$("$adb" devices | awk 'NR > 1 && $2 == "device" { print $1 }')"
  local count
  count="$(printf '%s\n' "$devices" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [[ "$count" == "1" ]]; then
    printf '%s\n' "$devices"
    return
  fi
  if [[ "$count" == "0" ]]; then
    echo "No Android device or emulator is connected." >&2
  else
    echo "Multiple Android devices are connected. Pass --device <adb-serial>." >&2
  fi
  return 1
}

latest_play_debug_apk() {
  if [[ ! -d "${ANDROID_DIR}/app/build/outputs/apk/play/debug" ]]; then
    return 0
  fi
  find "${ANDROID_DIR}/app/build/outputs/apk/play/debug" -maxdepth 1 -name '*-play-debug.apk' -print 2>/dev/null | sort | tail -n 1
}

OUTPUT_DIR="${ANDROID_DIR}/fastlane/metadata/android/${LOCALE}/images/phoneScreenshots"
ADB_SERIAL="${DEVICE:-<auto>}"

echo "Android screenshot output: ${OUTPUT_DIR}"
echo "Scenes: ${SCENES[*]}"
echo "ADB device: ${ADB_SERIAL}"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "Dry run complete. No build, install, or capture commands were executed."
  exit 0
fi

ADB_BIN="$(adb_bin)"
ADB_SERIAL="$(resolve_device "$ADB_BIN")"
mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_DIR"/*.png

if [[ "$SKIP_INSTALL" != "1" ]]; then
  if [[ "$SKIP_BUILD" != "1" ]]; then
    (
      cd "$ANDROID_DIR"
      ./gradlew :app:assemblePlayDebug
    )
  fi
  APK_PATH="$(latest_play_debug_apk)"
  if [[ -z "$APK_PATH" ]]; then
    echo "No existing Play debug APK found. Run without --skip-build first." >&2
    exit 1
  fi
  "$ADB_BIN" -s "$ADB_SERIAL" install -r "$APK_PATH" >/dev/null
elif [[ "$SKIP_BUILD" != "1" ]]; then
  (
    cd "$ANDROID_DIR"
    ./gradlew :app:assemblePlayDebug
  )
fi

for scene in "${SCENES[@]}"; do
  output_path="${OUTPUT_DIR}/openclaw-${scene}.png"
  "$ADB_BIN" -s "$ADB_SERIAL" shell am force-stop ai.openclaw.app >/dev/null
  "$ADB_BIN" -s "$ADB_SERIAL" shell am start -W \
    -n ai.openclaw.app/.MainActivity \
    --ez openclaw.screenshotMode true \
    --es openclaw.screenshotScene "$scene" >/dev/null
  sleep "${ANDROID_SCREENSHOT_SETTLE_SECONDS:-1.5}"
  "$ADB_BIN" -s "$ADB_SERIAL" exec-out screencap -p >"$output_path"
  echo "Captured ${output_path}"
done

echo "Android screenshots written to ${OUTPUT_DIR}"
