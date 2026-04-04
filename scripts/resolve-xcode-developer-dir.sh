#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${DEVELOPER_DIR:-}" && -d "${DEVELOPER_DIR}" ]]; then
  printf '%s\n' "${DEVELOPER_DIR}"
  exit 0
fi

if [[ -n "${XCODE_DEVELOPER_DIR:-}" && -d "${XCODE_DEVELOPER_DIR}" ]]; then
  printf '%s\n' "${XCODE_DEVELOPER_DIR}"
  exit 0
fi

if [[ -n "${XCODE_APP:-}" ]]; then
  candidate="${XCODE_APP%/}/Contents/Developer"
  if [[ -d "${candidate}" ]]; then
    printf '%s\n' "${candidate}"
    exit 0
  fi
fi

selected_dir="$(xcode-select -p 2>/dev/null || true)"
if [[ -n "${selected_dir}" && -d "${selected_dir}" && "${selected_dir}" != "/Library/Developer/CommandLineTools" ]]; then
  printf '%s\n' "${selected_dir}"
  exit 0
fi

for app_path in \
  "/Applications/Xcode.app" \
  "/Applications/Xcode-beta.app"
do
  candidate="${app_path}/Contents/Developer"
  if [[ -d "${candidate}" ]]; then
    printf '%s\n' "${candidate}"
    exit 0
  fi
done

spotlight_app="$(mdfind 'kMDItemCFBundleIdentifier == "com.apple.dt.Xcode"' 2>/dev/null | head -n 1 || true)"
if [[ -n "${spotlight_app}" ]]; then
  candidate="${spotlight_app%/}/Contents/Developer"
  if [[ -d "${candidate}" ]]; then
    printf '%s\n' "${candidate}"
    exit 0
  fi
fi

exit 1
