#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
XCODE_RESOLVER="${ROOT_DIR}/scripts/resolve-xcode-developer-dir.sh"
XCODE_WRAPPER="${ROOT_DIR}/scripts/with-xcode-developer-dir.sh"
TEAM_HELPER="${ROOT_DIR}/scripts/ios-team-id.sh"
SIMULATOR_HELPER="${ROOT_DIR}/scripts/resolve-ios-simulator.sh"
IOS_PROJECT="${ROOT_DIR}/apps/ios/OpenClaw.xcodeproj"
IOS_SCHEME="OpenClaw"
SHOWDESTINATIONS_TIMEOUT_SECONDS="${IOS_SHOWDESTINATIONS_TIMEOUT_SECONDS:-20}"

failures=0
warnings=0
runtime_missing=0
team_missing=0
identity_missing=0
asc_missing=0

say_section() {
  printf '\n[%s]\n' "$1"
}

say_ok() {
  printf 'OK   %s\n' "$1"
}

say_warn() {
  printf 'WARN %s\n' "$1"
  warnings=$((warnings + 1))
}

say_fail() {
  printf 'FAIL %s\n' "$1"
  failures=$((failures + 1))
}

trim() {
  local value="${1:-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

find_local_signing_team() {
  local file team
  for file in \
    "${ROOT_DIR}/apps/ios/.local-signing.xcconfig" \
    "${ROOT_DIR}/apps/ios/LocalSigning.xcconfig"; do
    [[ -f "${file}" ]] || continue
    team="$(
      awk -F '=' '
        /OPENCLAW_(DEVELOPMENT_TEAM|IOS_SELECTED_TEAM)[[:space:]]*=/ {
          value = $2
          gsub(/\r/, "", value)
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
          print value
          exit
        }
      ' "${file}" 2>/dev/null || true
    )"
    team="$(trim "${team}")"
    if [[ "${team}" =~ ^[A-Z0-9]{10}$ ]]; then
      printf '%s\t%s\n' "${team}" "${file}"
      return 0
    fi
  done
  return 1
}

run_with_timeout_capture() {
  local timeout_seconds="${1:-0}"
  shift

  local output_file status_file pid elapsed timed_out output status
  output_file="$(mktemp "${TMPDIR:-/tmp}/openclaw-timeout-output.XXXXXX")"
  status_file="$(mktemp "${TMPDIR:-/tmp}/openclaw-timeout-status.XXXXXX")"

  (
    "$@" >"${output_file}" 2>&1
    printf '%s' "$?" >"${status_file}"
  ) 2>/dev/null &
  pid=$!

  for ((elapsed = 0; elapsed < timeout_seconds; elapsed += 1)); do
    if ! kill -0 "${pid}" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  timed_out=0
  if kill -0 "${pid}" 2>/dev/null; then
    timed_out=1
    pkill -TERM -P "${pid}" 2>/dev/null || true
    kill -TERM "${pid}" 2>/dev/null || true
    sleep 1
    pkill -KILL -P "${pid}" 2>/dev/null || true
    kill -KILL "${pid}" 2>/dev/null || true
  fi

  wait "${pid}" 2>/dev/null || true

  output="$(cat "${output_file}" 2>/dev/null || true)"
  status="$(cat "${status_file}" 2>/dev/null || true)"
  rm -f "${output_file}" "${status_file}"

  printf '%s' "${output}"

  if (( timed_out == 1 )); then
    return 124
  fi
  if [[ -n "${status}" && "${status}" =~ ^[0-9]+$ ]]; then
    return "${status}"
  fi
  return 1
}

developer_dir="$("${XCODE_RESOLVER}" 2>/dev/null || true)"
selected_dir="$(xcode-select -p 2>/dev/null || true)"

say_section "Xcode"
if [[ -z "${developer_dir}" ]]; then
  say_fail "Could not resolve a full Xcode developer directory."
else
  say_ok "Using DEVELOPER_DIR=${developer_dir}"
  if [[ "${selected_dir}" == "/Library/Developer/CommandLineTools" ]]; then
    say_warn "xcode-select still points to CommandLineTools; wrapper scripts will override this locally."
  elif [[ -n "${selected_dir}" && "${selected_dir}" != "${developer_dir}" ]]; then
    say_warn "xcode-select points to ${selected_dir}; local wrapper will use ${developer_dir}."
  fi
fi

if ! command -v xcodebuild >/dev/null 2>&1; then
  say_fail "xcodebuild is not available on PATH."
fi

if ! command -v xcodegen >/dev/null 2>&1; then
  say_fail "xcodegen is not installed."
else
  say_ok "xcodegen is installed."
fi

if ! command -v fastlane >/dev/null 2>&1; then
  say_fail "fastlane is not installed."
else
  say_ok "fastlane is installed."
fi

say_section "Project"
if [[ ! -d "${IOS_PROJECT}" ]]; then
  say_warn "Missing ${IOS_PROJECT}; generating the project now."
  if (cd "${ROOT_DIR}" && pnpm ios:gen >/dev/null); then
    say_ok "Generated iOS project."
  else
    say_fail "Unable to generate iOS project with pnpm ios:gen."
  fi
else
  say_ok "Found ${IOS_PROJECT}."
fi

say_section "Runtime"
showdestinations_output=""
showdestinations_status=0
if [[ -n "${developer_dir}" && -d "${IOS_PROJECT}" ]]; then
  if ! showdestinations_output="$(
    run_with_timeout_capture "${SHOWDESTINATIONS_TIMEOUT_SECONDS}" \
      env DEVELOPER_DIR="${developer_dir}" \
      xcodebuild \
      -project "${IOS_PROJECT}" \
      -scheme "${IOS_SCHEME}" \
      -showdestinations
  )"; then
    showdestinations_status="$?"
  fi
fi

if [[ "${showdestinations_status}" == "124" ]]; then
  say_warn "xcodebuild -showdestinations timed out after ${SHOWDESTINATIONS_TIMEOUT_SECONDS}s; falling back to simctl runtime detection."
fi

available_devices="$(
  if [[ -n "${developer_dir}" ]]; then
    DEVELOPER_DIR="${developer_dir}" xcrun simctl list devices available 2>/dev/null || true
  fi
)"
simulator_json=""
simulator_available=0
if [[ -x "${SIMULATOR_HELPER}" ]]; then
  if simulator_json="$("${SIMULATOR_HELPER}" --json 2>/dev/null)"; then
    simulator_available=1
  fi
fi

if grep -q "iOS .* is not installed" <<<"${showdestinations_output}"; then
  missing_line="$(grep "iOS .* is not installed" <<<"${showdestinations_output}" | head -n 1)"
  missing_line="$(trim "${missing_line}")"
  if [[ "${missing_line}" == *"error:"* ]]; then
    missing_line="${missing_line##*error:}"
    missing_line="$(trim "${missing_line}")"
  fi
  missing_line="${missing_line%\}}"
  missing_line="$(trim "${missing_line}")"
  runtime_missing=1
  say_fail "${missing_line}"
elif [[ "${simulator_available}" == "1" ]]; then
  say_ok "At least one iOS simulator runtime/device is available."
  simulator_name="$(printf '%s' "${simulator_json}" | jq -r '.name')"
  simulator_runtime="$(printf '%s' "${simulator_json}" | jq -r '.runtime')"
  simulator_state="$(printf '%s' "${simulator_json}" | jq -r '.state')"
  say_ok "Build/run will auto-select ${simulator_name} (${simulator_runtime}, ${simulator_state})."
elif grep -qE '^-- iOS [0-9]' <<<"${available_devices}"; then
  runtime_missing=1
  say_fail "An iOS simulator runtime is installed, but no available simulator device could be auto-selected."
elif [[ "$(grep -c 'com.apple.CoreSimulator.SimDeviceType' <<<"${available_devices}" || true)" -eq 0 ]]; then
  runtime_missing=1
  say_fail "No available iOS simulator devices are installed yet."
else
  say_ok "At least one iOS simulator runtime/device is available."
  if [[ -x "${SIMULATOR_HELPER}" ]]; then
    say_fail "Available runtimes exist, but auto-selection of a simulator failed."
  fi
fi

if grep -q "Any iOS Device" <<<"${showdestinations_output}" && ! grep -q "error:" <<<"${showdestinations_output}"; then
  say_ok "Xcode can resolve an iOS device destination."
fi

say_section "Signing"
team_output=""
local_signing_team=""
local_signing_file=""
if local_signing_info="$(find_local_signing_team 2>/dev/null || true)"; then
  local_signing_team="${local_signing_info%%$'\t'*}"
  local_signing_file="${local_signing_info#*$'\t'}"
fi
if team_output="$(IOS_ALLOW_KEYCHAIN_TEAM_FALLBACK=1 bash "${TEAM_HELPER}" 2>&1)"; then
  team_id="$(trim "${team_output}")"
  say_ok "Resolved Apple Team ID ${team_id}."
  if [[ -n "${local_signing_team}" && "${local_signing_team}" != "${team_id}" ]]; then
    pretty_local_signing_file="${local_signing_file#"${ROOT_DIR}/"}"
    say_warn "Local signing override ${pretty_local_signing_file} pins Team ${local_signing_team}; run ./scripts/ios-configure-signing.sh to refresh it to ${team_id}."
  fi
else
  if grep -q "An Apple account is signed in to Xcode, but no Team ID could be resolved." <<<"${team_output}"; then
    team_message="Apple account is signed in to Xcode, but no Team ID has been resolved yet. Select a Team in Signing & Capabilities and build once, or set IOS_DEVELOPMENT_TEAM manually."
  elif grep -q "Configured Apple Team ID" <<<"${team_output}"; then
    team_message="$(trim "$(printf '%s\n' "${team_output}" | head -n 1)")"
  else
    team_message="$(trim "$(printf '%s\n' "${team_output}" | head -n 1)")"
  fi
  if [[ -n "${local_signing_team}" ]] && ! grep -q "Configured Apple Team ID" <<<"${team_output}"; then
    pretty_local_signing_file="${local_signing_file#"${ROOT_DIR}/"}"
    team_message="${team_message:-Could not resolve Apple Team ID.} Local signing override ${pretty_local_signing_file} currently pins Team ID ${local_signing_team}, but Xcode account state still has not resolved a Team ID for this Mac."
  fi
  team_missing=1
  say_fail "${team_message:-Could not resolve Apple Team ID.}"
fi

identity_output="$(security find-identity -p codesigning -v 2>/dev/null || true)"
identity_count="$(
  printf '%s\n' "${identity_output}" \
    | awk '/valid identities found/ {print $1}' \
    | tail -n 1
)"
identity_count="${identity_count:-0}"
if [[ "${identity_count}" =~ ^[0-9]+$ ]] && (( identity_count > 0 )); then
  say_ok "Found ${identity_count} valid code signing identit$( (( identity_count == 1 )) && printf 'y' || printf 'ies' )."
else
  identity_missing=1
  say_fail "No valid code signing identities found in Keychain."
fi

say_section "App Store Connect"
if command -v fastlane >/dev/null 2>&1; then
  asc_output="$(
    cd "${ROOT_DIR}/apps/ios" && \
      FASTLANE_SKIP_UPDATE_CHECK=1 CI=1 "${XCODE_WRAPPER}" fastlane ios auth_check 2>&1 || true
  )"
  if grep -q "App Store Connect API auth loaded successfully" <<<"${asc_output}"; then
    say_ok "App Store Connect API auth is configured."
  elif grep -q "Missing App Store Connect API key" <<<"${asc_output}"; then
    asc_missing=1
    say_fail "Missing App Store Connect API key. Set APP_STORE_CONNECT_API_KEY_PATH, ASC_KEY_PATH, or ASC_KEY_ID/ASC_ISSUER_ID with ASC_KEY_CONTENT."
  else
    asc_summary="$(
      printf '%s\n' "${asc_output}" \
        | rg -N --no-line-number 'Missing App Store Connect API key|ASC_KEY_|APP_STORE_CONNECT_API_KEY_PATH|auth loaded successfully' \
        | head -n 1 || true
    )"
    asc_summary="$(trim "${asc_summary}")"
    asc_missing=1
    say_fail "${asc_summary:-App Store Connect API auth is not configured.}"
  fi
else
  asc_missing=1
  say_fail "fastlane is required to validate App Store Connect API auth."
fi

say_section "Summary"
if (( failures == 0 )); then
  printf 'READY iOS release checks passed'
  if (( warnings > 0 )); then
    printf ' (%s warning%s)' "${warnings}" "$([[ "${warnings}" == "1" ]] && printf '' || printf 's')"
  fi
  printf '.\n'
  exit 0
fi

printf 'BLOCKED %s failure%s' "${failures}" "$([[ "${failures}" == "1" ]] && printf '' || printf 's')"
if (( warnings > 0 )); then
  printf ', %s warning%s' "${warnings}" "$([[ "${warnings}" == "1" ]] && printf '' || printf 's')"
fi
printf '.\n'

say_section "Next steps"
echo "Runbook: docs/platforms/apple-release-readiness.md"
echo "Repo gate: pnpm release:apple:repo-check"
echo "macOS tests: pnpm mac:test"
if (( runtime_missing == 1 )); then
  echo "Install the required iOS runtime in Xcode -> Settings -> Components, then verify with:"
  echo "  ./scripts/resolve-ios-simulator.sh --json"
fi
if (( team_missing == 1 )); then
  echo "Sign into Xcode with the release Apple Developer account, then verify with:"
  echo "  bash scripts/ios-team-id.sh"
  if [[ -n "${local_signing_team}" ]]; then
    pretty_local_signing_file="${local_signing_file#"${ROOT_DIR}/"}"
    echo "Local signing already pins Team ${local_signing_team} via ${pretty_local_signing_file}, but Xcode still needs to persist real account/team state."
  fi
  if grep -q "Only a Personal Team is currently available on this Mac." <<<"${team_output}"; then
    echo "Current Xcode state still exposes only a free Personal Team."
    echo "In Xcode -> Settings -> Accounts, sign in with a member of Team ${local_signing_team:-Y5PE65HELJ}, or invite the current Apple ID to that paid team."
    echo "If the paid team was just purchased or activated, refresh Xcode account state by signing out and back in after Apple finishes backend activation."
    echo "If Team ${local_signing_team:-Y5PE65HELJ} is no longer the intended release team, set IOS_DEVELOPMENT_TEAM in apps/ios/fastlane/.env and rerun:"
    echo "  ./scripts/ios-configure-signing.sh"
  fi
else
  if [[ -n "${local_signing_team:-}" && -n "${team_id:-}" && "${local_signing_team}" != "${team_id}" ]]; then
    echo "Refresh local signing overrides for the resolved team with:"
    echo "  ./scripts/ios-configure-signing.sh"
  fi
fi
if (( identity_missing == 1 )); then
  echo "Install/import valid Apple code-signing identities into Keychain, then verify with:"
  echo "  security find-identity -p codesigning -v"
fi
if (( asc_missing == 1 )); then
  echo "Configure App Store Connect API auth, then verify with:"
  echo "  Fill ASC_KEY_* or APP_STORE_CONNECT_API_KEY_PATH in apps/ios/fastlane/.env"
  echo "  scripts/ios-asc-keychain-setup.sh --key-path /absolute/path/to/AuthKey_XXXXXXXXXX.p8 --issuer-id YOUR_ISSUER_ID --write-env"
  echo "  cd apps/ios && ../../scripts/with-xcode-developer-dir.sh fastlane ios auth_check"
fi
echo "Re-run after fixes:"
echo "  pnpm release:apple:check"
echo "  pnpm release:apple:submit-check"
exit 1
