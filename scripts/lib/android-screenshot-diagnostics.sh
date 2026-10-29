#!/usr/bin/env bash

# Opt-in Linux diagnostics for disposable screenshot runners. Process listings
# contain names and resource counters only; Android app/debug tags are excluded.
SCREENSHOT_DIAGNOSTICS_DIR=""
SCREENSHOT_DIAGNOSTICS_SAMPLER_PID=""

screenshot_diagnostics_probe() (
  set +e
  local output="$1"
  local seconds="$2"
  shift 2
  timeout --signal=TERM --kill-after=2s "${seconds}s" "$@" 2>&1 |
    head -c 131072 >"$SCREENSHOT_DIAGNOSTICS_DIR/$output"
  printf '\nprobe_exit_status=%s\n' "${PIPESTATUS[0]}" >>"$SCREENSHOT_DIAGNOSTICS_DIR/$output"
  exit 0
)

screenshot_diagnostics_host_sample() (
  set +e
  timeout --kill-after=2s 3s /bin/bash -c '
    printf "\ntimestamp=%s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    head -n 1 /proc/stat
    grep -E "^(MemTotal|MemAvailable|SwapTotal|SwapFree|Dirty|Writeback):" /proc/meminfo
    for pressure in cpu memory io; do
      printf "pressure_%s " "$pressure"
      cat "/proc/pressure/$pressure"
    done
    printf "loadavg "
    cat /proc/loadavg
    ps -eo pid=,comm=,pcpu=,pmem=,rss= --sort=-rss | head -n 12
    if [[ -f "$1/emulator.pid" ]]; then
      read -r emulator_pid <"$1/emulator.pid"
      if [[ -n "$emulator_pid" ]]; then
        printf "owned_emulator "
        ps -p "$emulator_pid" -o pid=,comm=,pcpu=,pmem=,rss=,nlwp=
      fi
    fi
  ' _ "$SCREENSHOT_DIAGNOSTICS_DIR"
  exit 0
)

screenshot_diagnostics_start() {
  [[ "$(uname -s)" == "Linux" ]] && command -v timeout >/dev/null 2>&1 || return 0
  SCREENSHOT_DIAGNOSTICS_DIR="$1/diagnostics"
  SCREENSHOT_DIAGNOSTICS_ADB="$2"
  mkdir -p "$SCREENSHOT_DIAGNOSTICS_DIR" || { SCREENSHOT_DIAGNOSTICS_DIR=""; return 0; }
  (
    set +e
    trap 'kill "${sample_sleep_pid:-}" 2>/dev/null; exit 0' TERM INT
    # Bound sampling even if the caller is interrupted before normal cleanup.
    for ((sample = 0; sample < 1440; sample++)); do
      screenshot_diagnostics_host_sample
      sleep 5 &
      sample_sleep_pid="$!"
      wait "$sample_sleep_pid"
    done
  ) >>"$SCREENSHOT_DIAGNOSTICS_DIR/host-resources.log" 2>&1 &
  SCREENSHOT_DIAGNOSTICS_SAMPLER_PID="$!"
  screenshot_diagnostics_probe host-identity.txt 5 uname -srmo
  screenshot_diagnostics_probe cpu-count.txt 5 getconf _NPROCESSORS_ONLN
  screenshot_diagnostics_probe emulator-version.txt 10 "${ANDROID_EMULATOR:-emulator}" -no-window -version
  screenshot_diagnostics_probe system-image-packages.txt 5 /bin/bash -c '
    for properties in "$1"/system-images/android-{34,36}/*/*/source.properties; do
      [[ -f "$properties" ]] || continue
      printf "\n%s\n" "$properties"
      cat "$properties"
    done
  ' _ "${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
  return 0
}

screenshot_diagnostics_phase() {
  [[ -n "$SCREENSHOT_DIAGNOSTICS_DIR" ]] || return 0
  printf '%s phase=%s serial=%s emulator_pid=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" \
    >>"$SCREENSHOT_DIAGNOSTICS_DIR/phases.log" || true
  if [[ -n "$3" ]]; then
    printf '%s\n' "$3" >"$SCREENSHOT_DIAGNOSTICS_DIR/emulator.pid" || true
  fi
  return 0
}

screenshot_diagnostics_finish() {
  [[ -n "$SCREENSHOT_DIAGNOSTICS_DIR" ]] || return 0
  local status="$1"
  local serial="$2"
  local emulator_pid="$3"
  screenshot_diagnostics_phase "finished-status-$status" "$serial" "$emulator_pid"
  if [[ -n "$SCREENSHOT_DIAGNOSTICS_SAMPLER_PID" ]]; then
    kill "$SCREENSHOT_DIAGNOSTICS_SAMPLER_PID" 2>/dev/null || true
    wait "$SCREENSHOT_DIAGNOSTICS_SAMPLER_PID" 2>/dev/null || true
  fi
  screenshot_diagnostics_host_sample >>"$SCREENSHOT_DIAGNOSTICS_DIR/host-resources.log" 2>&1 || true
  [[ -n "$serial" ]] || return 0
  screenshot_diagnostics_probe guest-identity.txt 10 "$SCREENSHOT_DIAGNOSTICS_ADB" -s "$serial" shell \
    'for key in ro.build.fingerprint ro.build.version.release ro.build.version.sdk ro.kernel.qemu sys.boot_completed debug.hwui.renderer; do echo "$key=$(getprop "$key")"; done'
  [[ "$status" != "0" ]] || return 0
  # Preserve failure evidence before display restoration or emulator teardown.
  screenshot_diagnostics_probe system-events.log 15 "$SCREENSHOT_DIAGNOSTICS_ADB" -s "$serial" logcat \
    -b system -b events -b crash -d -t 500 -v threadtime \
    'ActivityManager:E' 'InputDispatcher:E' 'WindowManager:E' 'SurfaceFlinger:E' 'Watchdog:E' \
    'lmkd:I' 'am_anr:I' 'am_crash:I' 'am_kill:I' 'am_low_memory:I' '*:S'
  screenshot_diagnostics_probe last-anr.txt 15 "$SCREENSHOT_DIAGNOSTICS_ADB" -s "$serial" shell dumpsys activity lastanr
  screenshot_diagnostics_probe system-app-anr.txt 15 "$SCREENSHOT_DIAGNOSTICS_ADB" -s "$serial" shell \
    dumpsys dropbox --print system_app_anr
  screenshot_diagnostics_probe systemui-exit-info.txt 15 "$SCREENSHOT_DIAGNOSTICS_ADB" -s "$serial" shell \
    dumpsys activity exit-info com.android.systemui
  screenshot_diagnostics_probe guest-cpuinfo.txt 10 "$SCREENSHOT_DIAGNOSTICS_ADB" -s "$serial" shell dumpsys cpuinfo
  screenshot_diagnostics_probe systemui-meminfo.txt 10 "$SCREENSHOT_DIAGNOSTICS_ADB" -s "$serial" shell \
    dumpsys meminfo com.android.systemui
  screenshot_diagnostics_probe guest-resources.txt 10 "$SCREENSHOT_DIAGNOSTICS_ADB" -s "$serial" shell \
    'cat /proc/meminfo; for resource in cpu memory io; do echo "$resource pressure"; cat "/proc/pressure/$resource"; done'
  local systemui_pid
  systemui_pid="$(timeout --kill-after=2s 5s "$SCREENSHOT_DIAGNOSTICS_ADB" -s "$serial" shell pidof com.android.systemui 2>/dev/null | tr -d '\r')" || systemui_pid=""
  if [[ -n "$systemui_pid" ]]; then
    screenshot_diagnostics_probe systemui-crash.log 10 "$SCREENSHOT_DIAGNOSTICS_ADB" -s "$serial" logcat \
      -b crash -d -t 300 -v threadtime --pid="$systemui_pid"
  fi
  return 0
}
