#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/android-screenshots.sh [--device <adb-serial>] [--avd <name>] [--locale en-US] [--skip-build] [--skip-install] [--keep-emulator] [--dry-run]

Builds and installs the Play debug app, launches deterministic screenshot scenes,
and writes raw Google Play screenshots under:
  apps/android/fastlane/metadata/android/<locale>/images/phoneScreenshots/

If no ADB device is connected, pass --avd or set ANDROID_SCREENSHOT_AVD to boot
an emulator non-interactively for the screenshot run.
EOF
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="${ROOT_DIR}/apps/android"
LOCALE="en-US"
DEVICE="${ANDROID_SCREENSHOT_DEVICE:-}"
AVD="${ANDROID_SCREENSHOT_AVD:-}"
KEEP_EMULATOR="${ANDROID_SCREENSHOT_KEEP_EMULATOR:-0}"
SKIP_BUILD=0
SKIP_INSTALL=0
DRY_RUN=0
SCENES=(connect chat voice screen settings)
EMULATOR_PID=""
EMULATOR_LOG=""
STARTED_EMULATOR=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --device)
      DEVICE="${2:-}"
      shift 2
      ;;
    --avd)
      AVD="${2:-}"
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
    --keep-emulator)
      KEEP_EMULATOR=1
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

validate_locale() {
  local locale="$1"
  if [[ "$locale" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]]; then
    return
  fi
  echo "Invalid Android screenshot locale: ${locale}" >&2
  echo "Use a locale tag like en-US or pt-BR; path separators and dot segments are not allowed." >&2
  exit 1
}

validate_locale "$LOCALE"

cleanup_started_emulator() {
  local stopped=0

  if [[ "$STARTED_EMULATOR" != "1" || "$KEEP_EMULATOR" == "1" ]]; then
    return
  fi
  if [[ -n "${ADB_BIN:-}" && -n "${ADB_SERIAL:-}" ]]; then
    if "$ADB_BIN" -s "$ADB_SERIAL" emu kill >/dev/null 2>&1; then
      stopped=1
    fi
  fi
  if [[ "$stopped" != "1" && -n "$EMULATOR_PID" ]]; then
    kill "$EMULATOR_PID" >/dev/null 2>&1 || true
  fi
}

cleanup_emulator_log() {
  if [[ -n "$EMULATOR_LOG" && -f "$EMULATOR_LOG" ]]; then
    rm -f "$EMULATOR_LOG"
  fi
}

cleanup() {
  cleanup_started_emulator
  cleanup_emulator_log
}

trap cleanup EXIT

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

emulator_bin() {
  if [[ -n "${ANDROID_EMULATOR:-}" ]]; then
    printf '%s\n' "$ANDROID_EMULATOR"
    return
  fi
  if command -v emulator >/dev/null 2>&1; then
    command -v emulator
    return
  fi
  for sdk_root in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Library/Android/sdk"; do
    if [[ -n "$sdk_root" && -x "$sdk_root/emulator/emulator" ]]; then
      printf '%s\n' "$sdk_root/emulator/emulator"
      return
    fi
  done
  echo "Android emulator binary not found. Install the Android emulator or set ANDROID_EMULATOR." >&2
  return 127
}

connected_devices() {
  local adb="$1"
  "$adb" devices | awk 'NR > 1 && $2 == "device" { print $1 }'
}

device_count() {
  local devices="$1"
  printf '%s\n' "$devices" | sed '/^$/d' | wc -l | tr -d ' '
}

wait_for_single_device() {
  local adb="$1"
  local timeout_seconds="${ANDROID_SCREENSHOT_EMULATOR_TIMEOUT_SECONDS:-180}"
  local deadline=$((SECONDS + timeout_seconds))
  local devices
  local count

  while (( SECONDS < deadline )); do
    devices="$(connected_devices "$adb")"
    count="$(device_count "$devices")"
    if [[ "$count" == "1" ]]; then
      printf '%s\n' "$devices"
      return
    fi
    sleep 2
  done

  echo "Timed out waiting for exactly one Android emulator device." >&2
  "$adb" devices -l >&2 || true
  return 1
}

wait_for_boot_completed() {
  local adb="$1"
  local serial="$2"
  local timeout_seconds="${ANDROID_SCREENSHOT_EMULATOR_TIMEOUT_SECONDS:-180}"
  local deadline=$((SECONDS + timeout_seconds))
  local boot_completed

  "$adb" -s "$serial" wait-for-device
  while (( SECONDS < deadline )); do
    boot_completed="$("$adb" -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
    if [[ "$boot_completed" == "1" ]]; then
      "$adb" -s "$serial" shell input keyevent 82 >/dev/null 2>&1 || true
      return
    fi
    sleep 2
  done

  echo "Timed out waiting for Android emulator boot completion on ${serial}." >&2
  return 1
}

wait_for_explicit_device() {
  local adb="$1"
  local serial="$2"
  local timeout_seconds="${ANDROID_SCREENSHOT_DEVICE_TIMEOUT_SECONDS:-30}"
  local deadline=$((SECONDS + timeout_seconds))
  local state

  while (( SECONDS < deadline )); do
    state="$("$adb" devices | awk -v serial="$serial" '$1 == serial { print $2 }')"
    if [[ "$state" == "device" ]]; then
      return
    fi
    sleep 2
  done

  if [[ -n "$state" ]]; then
    echo "Android device '${serial}' did not become usable within ${timeout_seconds}s; current adb state is '${state}'." >&2
  else
    echo "Android device '${serial}' was not found within ${timeout_seconds}s." >&2
  fi
  "$adb" devices -l >&2 || true
  return 1
}

stabilize_device_for_screenshots() {
  local adb="$1"
  local serial="$2"
  "$adb" -s "$serial" shell settings put global window_animation_scale 0 >/dev/null 2>&1 || true
  "$adb" -s "$serial" shell settings put global transition_animation_scale 0 >/dev/null 2>&1 || true
  "$adb" -s "$serial" shell settings put global animator_duration_scale 0 >/dev/null 2>&1 || true
}

boot_emulator() {
  local adb="$1"
  local avd="$2"
  local emulator
  local emulator_args
  local extra_args
  local serial

  emulator="$(emulator_bin)"
  EMULATOR_LOG="$(mktemp "${TMPDIR:-/tmp}/openclaw-android-screenshot-emulator.XXXXXX.log")"
  echo "No connected Android device found. Booting AVD '${avd}'." >&2
  emulator_args=(-avd "$avd" -no-window -no-audio -no-boot-anim)
  if [[ -n "${ANDROID_SCREENSHOT_EMULATOR_ARGS:-}" ]]; then
    read -r -a extra_args <<<"$ANDROID_SCREENSHOT_EMULATOR_ARGS"
    emulator_args+=("${extra_args[@]}")
  fi
  "$emulator" "${emulator_args[@]}" >"$EMULATOR_LOG" 2>&1 &
  EMULATOR_PID="$!"
  STARTED_EMULATOR=1

  serial="$(wait_for_single_device "$adb")"
  wait_for_boot_completed "$adb" "$serial"
  stabilize_device_for_screenshots "$adb" "$serial"
  ADB_SERIAL="$serial"
}

resolve_device() {
  local adb="$1"
  local devices
  local count

  if [[ -n "$DEVICE" ]]; then
    wait_for_explicit_device "$adb" "$DEVICE"
    stabilize_device_for_screenshots "$adb" "$DEVICE"
    ADB_SERIAL="$DEVICE"
    return
  fi
  devices="$(connected_devices "$adb")"
  count="$(device_count "$devices")"
  if [[ "$count" == "1" ]]; then
    stabilize_device_for_screenshots "$adb" "$devices"
    ADB_SERIAL="$devices"
    return
  fi
  if [[ "$count" == "0" ]]; then
    if [[ -n "$AVD" ]]; then
      boot_emulator "$adb" "$AVD"
      return
    fi
    echo "No Android device or emulator is connected." >&2
    echo "Start one manually, pass --device <adb-serial>, or pass --avd <name> to boot an emulator." >&2
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
ADB_SERIAL=""
ADB_DISPLAY="${DEVICE:-<auto>}"

echo "Android screenshot output: ${OUTPUT_DIR}"
echo "Scenes: ${SCENES[*]}"
echo "ADB device: ${ADB_DISPLAY}"
if [[ -n "$AVD" ]]; then
  echo "Fallback AVD: ${AVD}"
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "Dry run complete. No build, install, or capture commands were executed."
  exit 0
fi

ADB_BIN="$(adb_bin)"
resolve_device "$ADB_BIN"
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
