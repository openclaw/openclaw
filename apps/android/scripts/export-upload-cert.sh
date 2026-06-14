#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
android_dir="$(cd "${script_dir}/.." && pwd -P)"
output_path="${android_dir}/build/release-bundles/openclaw-upload-cert.pem"

usage() {
  echo "Usage: bash apps/android/scripts/export-upload-cert.sh [--output <pem-path>]"
}

resolve_output_path() {
  local raw_path="$1"

  if [[ "${raw_path}" = /* ]]; then
    printf '%s\n' "${raw_path}"
    return
  fi

  printf '%s\n' "$(pwd -P)/${raw_path}"
}

read_gradle_property() {
  local property_name="$1"
  local properties_path="${HOME}/.gradle/gradle.properties"

  awk -F'[:=]' -v key="${property_name}" '
    $0 !~ /^[[:space:]]*#/ && $0 !~ /^[[:space:]]*!/ {
      current_key = $1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", current_key)
      if (current_key == key) {
        sub(/^[^:=]+[:=][[:space:]]*/, "", $0)
        print $0
        exit
      }
    }
  ' "${properties_path}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --output)
      if [[ $# -lt 2 ]]; then
        echo "Missing value after --output" >&2
        exit 1
      fi
      output_path="$(resolve_output_path "$2")"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

store_file="${OPENCLAW_ANDROID_STORE_FILE:-$(read_gradle_property OPENCLAW_ANDROID_STORE_FILE)}"
store_password="${OPENCLAW_ANDROID_STORE_PASSWORD:-$(read_gradle_property OPENCLAW_ANDROID_STORE_PASSWORD)}"
key_alias="${OPENCLAW_ANDROID_KEY_ALIAS:-$(read_gradle_property OPENCLAW_ANDROID_KEY_ALIAS)}"

if [[ -z "${store_file}" || -z "${store_password}" || -z "${key_alias}" ]]; then
  echo "Missing Android signing config. Set OPENCLAW_ANDROID_STORE_FILE, OPENCLAW_ANDROID_STORE_PASSWORD, and OPENCLAW_ANDROID_KEY_ALIAS in env or ~/.gradle/gradle.properties." >&2
  exit 1
fi

if [[ "${store_file}" == "~/"* ]]; then
  store_file="${HOME}/${store_file#"~/"}"
fi

mkdir -p "$(dirname "${output_path}")"

if ! export_output="$(
  keytool -exportcert -rfc \
    -alias "${key_alias}" \
    -keystore "${store_file}" \
    -storepass "${store_password}" \
    -file "${output_path}" \
    2>&1
)"; then
  printf '%s\n' "${export_output}" >&2
  exit 1
fi

echo "Upload certificate PEM: ${output_path}"
keytool -printcert -file "${output_path}" \
  | awk '/^[[:space:]]*(Owner|Issuer|Serial number|Valid from|SHA1|SHA256):/ { sub(/^[[:space:]]+/, "", $0); print }'
