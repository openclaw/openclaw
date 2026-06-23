#!/bin/bash
# Install the unsigned OpenClaw iOS build onto a local iPhone using
# AltServer-Linux-PyScript.
#
# This script is meant to run on a Debian/Ubuntu machine that has USB or Wi-Fi
# access to the target iPhone. It downloads the unsigned .xcarchive artifact
# produced by the GitHub Actions unsigned-build workflow, converts it to an .ipa,
# and launches AltServer-Linux-PyScript to sign and install it with a free
# Apple ID.
#
# The Apple ID credentials are prompted interactively by AltServer; they are
# never stored or passed as command-line arguments.
#
# Requirements:
#   - Debian/Ubuntu (or similar apt-based distro)
#   - iPhone connected via USB (required for first-time pairing/install)
#   - iPhone unlocked and "Trust This Computer" tapped
#   - Free Apple Account (Apps signed this way expire after 7 days and must be
#     refreshed. Joining the paid Apple Developer Program removes that limit.)
#
# Environment variables:
#   ALTSERVER_REPO   - Git URL of AltServer-Linux-PyScript fork to use.
#                      Defaults to the SnoutFirst fork for auditability.
#   OPENCLAW_FORK    - GitHub fork that produced the unsigned artifact.
#                      Defaults to SnoutFirst/openclaw.
#   WORK_BRANCH      - Branch on OPENCLAW_FORK that has the unsigned build.
#   LOCAL_XCARCHIVE  - Path to a local .zip of the unsigned xcarchive artifact.
#                      If set, skips downloading from GitHub.
#   GH_TOKEN         - Optional GitHub token for artifact download if gh CLI
#                      is not installed and you want curl-based download.
#   SKIP_DEVICE_CHECK - Set to "1" to skip the pre-flight device check.
#
# Example:
#   sudo ./scripts/ios-install-via-altserver.sh
#
#   # Use your own fork of AltServer-Linux-PyScript:
#   ALTSERVER_REPO=https://github.com/yourname/AltServer-Linux-PyScript \
#     sudo ./scripts/ios-install-via-altserver.sh

set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo "ERROR: This script must be run as root (e.g. sudo $0)." >&2
  exit 1
fi

ALTSERVER_REPO="${ALTSERVER_REPO:-https://github.com/SnoutFirst/AltServer-Linux-PyScript}"
OPENCLAW_FORK="${OPENCLAW_FORK:-https://github.com/SnoutFirst/openclaw}"
OPENCLAW_OWNER="${OPENCLAW_FORK#https://github.com/}"
WORK_BRANCH="${WORK_BRANCH:-ci/build-ios-unsigned}"
ARTIFACT_NAME="OpenClaw-iOS-unsigned-xcarchive"
LOCAL_XCARCHIVE="${LOCAL_XCARCHIVE:-}"
GH_TOKEN="${GH_TOKEN:-}"
SKIP_DEVICE_CHECK="${SKIP_DEVICE_CHECK:-}"

WORK_DIR="${HOME}/.openclaw-ios-install"
IPA_PATH="${WORK_DIR}/OpenClaw.ipa"

log() {
  echo "==> $*"
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

install_deps() {
  log "Checking system dependencies..."
  if ! command -v apt-get >/dev/null 2>&1; then
    die "This script requires apt-get (Debian/Ubuntu)."
  fi

  local missing_pkgs=()
  for pkg in usbmuxd libimobiledevice6 libimobiledevice-utils wget curl python3 unzip zip git libavahi-compat-libdnssd-dev; do
    if ! dpkg -s "$pkg" >/dev/null 2>&1; then
      missing_pkgs+=("$pkg")
    fi
  done

  if [[ ${#missing_pkgs[@]} -gt 0 ]]; then
    log "Installing missing packages: ${missing_pkgs[*]}"
    apt-get update || die "apt-get update failed."
    apt-get install -y "${missing_pkgs[@]}" || die "apt-get install failed for packages: ${missing_pkgs[*]}"
  fi

  log "Starting device communication services..."
  # usbmuxd is required for USB iPhone communication.
  systemctl restart usbmuxd 2>/dev/null || {
    echo "WARNING: could not restart usbmuxd via systemctl; trying direct start."
    usbmuxd 2>/dev/null || true
  }

  # Avahi is only needed for Wi-Fi discovery; don't fail the whole script if it
  # isn't available (e.g. in a minimal container).
  for svc in avahi-daemon.service avahi-daemon.socket; do
    if ! systemctl start "$svc" 2>/dev/null; then
      echo "WARNING: could not start ${svc}. Wi-Fi device discovery may not work."
    fi
  done

  # Give usbmuxd a moment to settle.
  sleep 2
}

detect_device() {
  if [[ "$SKIP_DEVICE_CHECK" == "1" ]]; then
    return 0
  fi

  if ! command -v idevice_id >/dev/null 2>&1; then
    echo "WARNING: idevice_id not found. Skipping device detection."
    return 0
  fi

  local devices
  devices=$(idevice_id -l 2>/dev/null || true)
  if [[ -n "$devices" ]]; then
    echo
    log "Detected iOS device(s):"
    echo "$devices"
    echo
    return 0
  fi

  return 1
}

wait_for_device() {
  log "Waiting for an iOS device to be detected..."
  echo
  echo "************************************************************"
  echo "  Please connect your iPhone to this computer via USB,"
  echo "  unlock it, and tap 'Trust This Computer' if prompted."
  echo "************************************************************"
  echo

  local attempts=0
  while ! detect_device; do
    attempts=$((attempts + 1))
    if [[ "$attempts" -ge 30 ]]; then
      echo
      echo "ERROR: No iOS device detected after ~60 seconds."
      echo
      echo "Troubleshooting:"
      echo "  1. Make sure the iPhone is plugged in via USB."
      echo "  2. Unlock the iPhone and trust the computer."
      echo "  3. Try a different USB cable/port (cheap cables often fail)."
      echo "  4. Run 'lsusb' and look for an Apple device."
      echo "  5. Run 'idevice_id -l' manually to verify detection."
      echo
      echo "If you want to skip this check, re-run with:"
      echo "  SKIP_DEVICE_CHECK=1 sudo $0"
      echo
      exit 1
    fi
    sleep 2
  done
}

download_artifact_with_gh() {
  log "Downloading latest unsigned xcarchive from ${OPENCLAW_FORK}..."
  if ! command -v gh >/dev/null 2>&1; then
    die "gh CLI is not installed. Either install it, or set LOCAL_XCARCHIVE to a downloaded artifact zip."
  fi

  local run_id
  run_id=$(gh run list \
    --repo "${OPENCLAW_OWNER}" \
    --branch "${WORK_BRANCH}" \
    --workflow build-ios-unsigned.yml \
    --limit 1 \
    --json databaseId \
    --jq '.[0].databaseId')

  if [[ -z "$run_id" ]]; then
    die "Could not find a recent unsigned build run on ${WORK_BRANCH}."
  fi

  rm -rf "${WORK_DIR}/artifact"
  mkdir -p "${WORK_DIR}/artifact"
  gh run download "$run_id" \
    --repo "${OPENCLAW_OWNER}" \
    --name "$ARTIFACT_NAME" \
    --dir "${WORK_DIR}/artifact"
}

download_artifact_with_curl() {
  log "Downloading latest unsigned xcarchive via curl..."
  if [[ -z "$GH_TOKEN" ]]; then
    die "GH_TOKEN is required for curl-based download because gh CLI is not installed."
  fi

  rm -rf "${WORK_DIR}/artifact"
  mkdir -p "${WORK_DIR}/artifact"

  local api_url="https://api.github.com/repos/${OPENCLAW_OWNER}/actions/runs"
  local run_id
  run_id=$(curl -sS -H "Authorization: Bearer ${GH_TOKEN}" \
    "${api_url}?branch=${WORK_BRANCH}&per_page=1" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["workflow_runs"][0]["id"])')

  if [[ -z "$run_id" ]]; then
    die "Could not find a recent unsigned build run on ${WORK_BRANCH}."
  fi

  local artifact_id
  artifact_id=$(curl -sS -H "Authorization: Bearer ${GH_TOKEN}" \
    "${api_url}/${run_id}/artifacts" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(next(a["id"] for a in d["artifacts"] if a["name"]=="'"${ARTIFACT_NAME}"'"))')

  curl -sS -L -H "Authorization: Bearer ${GH_TOKEN}" \
    "https://api.github.com/repos/${OPENCLAW_OWNER}/actions/artifacts/${artifact_id}/zip" \
    -o "${WORK_DIR}/artifact.zip"

  unzip -q "${WORK_DIR}/artifact.zip" -d "${WORK_DIR}/artifact"
  rm -f "${WORK_DIR}/artifact.zip"
}

prepare_artifact() {
  mkdir -p "$WORK_DIR"

  if [[ -n "$LOCAL_XCARCHIVE" ]]; then
    log "Using local artifact: ${LOCAL_XCARCHIVE}"
    rm -rf "${WORK_DIR}/artifact"
    mkdir -p "${WORK_DIR}/artifact"
    unzip -q "$LOCAL_XCARCHIVE" -d "${WORK_DIR}/artifact"
    return
  fi

  if command -v gh >/dev/null 2>&1; then
    download_artifact_with_gh
    return
  fi

  if [[ -n "$GH_TOKEN" ]]; then
    download_artifact_with_curl
    return
  fi

  echo
  echo "ERROR: Cannot download the GitHub Actions artifact automatically."
  echo "Either:"
  echo "  1. Install the GitHub CLI (gh) and authenticate it:"
  echo "       https://github.com/cli/cli#installation"
  echo "  2. Set GH_TOKEN to a personal access token with repo scope."
  echo "  3. Download the artifact manually from the workflow run page:"
  echo "       https://github.com/${OPENCLAW_OWNER}/actions/workflows/build-ios-unsigned.yml"
  echo "     then re-run this script with:"
  echo "       LOCAL_XCARCHIVE=/path/to/OpenClaw-iOS-unsigned-xcarchive.zip sudo ./ios-install-via-altserver.sh"
  echo
  exit 1
}

build_ipa() {
  log "Converting .xcarchive to .ipa..."
  cd "$WORK_DIR"

  rm -rf Payload OpenClaw.ipa
  mkdir -p Payload

  local app_path
  app_path=$(find artifact -name '*.app' -type d | head -n1)
  if [[ -z "$app_path" ]]; then
    die "No .app found inside the xcarchive artifact."
  fi

  cp -R "$app_path" Payload/
  zip -qr OpenClaw.ipa Payload

  echo
  log "IPA ready: ${IPA_PATH}"
  echo
}

setup_altserver() {
  log "Setting up AltServer-Linux-PyScript from ${ALTSERVER_REPO}..."
  cd "$WORK_DIR"

  if [[ -d AltServer-Linux-PyScript ]]; then
    git -C AltServer-Linux-PyScript pull --ff-only || true
  else
    git clone --depth 1 "$ALTSERVER_REPO" AltServer-Linux-PyScript
  fi

  # Sanity-check downloaded binaries. AltServer-Linux-PyScript downloads
  # resources on first run; if the download URL 404s, the "binary" can be an
  # HTML error page and will fail with confusing "Not: not found" errors.
  local resource_dir="${WORK_DIR}/AltServer-Linux-PyScript/resource"
  if [[ -d "$resource_dir" ]]; then
    for bin in AltServer netmuxd anisette-server; do
      local path="$resource_dir/$bin"
      if [[ -f "$path" ]] && ! file "$path" | grep -qE 'ELF|Mach-O'; then
        echo
        echo "WARNING: $path does not look like a valid executable binary."
        echo "         It may be a failed-download placeholder. Removing it so"
        echo "         AltServer-Linux-PyScript can re-download."
        rm -f "$path"
      fi
    done
  fi
}

install_ipa() {
  cat <<'BANNER'

============================================================
  Ready to sign and install OpenClaw on your iPhone.

  1. Make sure your iPhone is still connected via USB and
     remains unlocked.
  2. In the AltServer menu that appears, choose
     "Install custom IPA" and enter this path:

       ~/.openclaw-ios-install/OpenClaw.ipa

  3. Enter your Apple ID email and app-specific password
     (or your regular password + 2FA code) when prompted.

  NOTE: Apps installed with a free Apple Account must be
  refreshed every 7 days. The same AltServer tool can refresh
  them over Wi-Fi after the first USB install.
============================================================

BANNER

  cd "${WORK_DIR}/AltServer-Linux-PyScript"
  python3 main.py
}

main() {
  install_deps
  wait_for_device
  prepare_artifact
  build_ipa
  setup_altserver
  install_ipa
}

main "$@"
