#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/resolve-ios-simulator.sh [--destination|--name|--udid|--json|--shell]

Resolves an available iOS simulator for local build/run flows.

Env overrides:
  IOS_DEST        Explicit xcodebuild destination. If it includes id= or name=,
                  the resolver will try to match the same device.
  IOS_SIM         Preferred simulator name or UDID.
  IOS_SIM_UDID    Preferred simulator UDID.
  IOS_SIM_PREFER  Comma-separated preferred simulator names for auto-selection.
EOF
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
XCODE_WRAPPER="${ROOT_DIR}/scripts/with-xcode-developer-dir.sh"

if [[ ! -x "${XCODE_WRAPPER}" ]]; then
  echo "Missing Xcode wrapper: ${XCODE_WRAPPER}" >&2
  exit 1
fi

mode="destination"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --destination)
      mode="destination"
      shift
      ;;
    --name)
      mode="name"
      shift
      ;;
    --udid)
      mode="udid"
      shift
      ;;
    --json)
      mode="json"
      shift
      ;;
    --shell)
      mode="shell"
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

requested_dest="${IOS_DEST:-}"
requested_sim="${IOS_SIM:-}"
requested_udid="${IOS_SIM_UDID:-}"

if [[ -z "${requested_udid}" && "${requested_dest}" =~ (^|,)id=([^,]+)($|,) ]]; then
  requested_udid="${BASH_REMATCH[2]}"
fi

if [[ -z "${requested_sim}" && "${requested_dest}" =~ (^|,)name=([^,]+)($|,) ]]; then
  requested_sim="${BASH_REMATCH[2]}"
fi

preferred_json="$(
  if [[ -n "${IOS_SIM_PREFER:-}" ]]; then
    printf '%s' "${IOS_SIM_PREFER}" \
      | tr ',' '\n' \
      | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' \
      | sed '/^$/d' \
      | jq -R . \
      | jq -s .
  else
    printf '%s\n' \
      "iPhone 17 Pro" \
      "iPhone 17" \
      "iPhone 16 Pro" \
      "iPhone 16" \
      "iPhone 15 Pro" \
      "iPhone 15" \
      "iPhone 14 Pro" \
      "iPhone 14" \
      | jq -R . \
      | jq -s .
  fi
)"

devices_json="$("${XCODE_WRAPPER}" xcrun simctl list devices available --json 2>/dev/null || true)"
if [[ -z "${devices_json}" ]]; then
  echo "Unable to query iOS simulator devices with simctl." >&2
  exit 1
fi

selected_json="$(
  printf '%s' "${devices_json}" | jq -c \
    --arg requestedDest "${requested_dest}" \
    --arg requestedSim "${requested_sim}" \
    --arg requestedUdid "${requested_udid}" \
    --argjson preferred "${preferred_json}" '
      def runtime_version($runtime):
        ($runtime | capture("iOS-(?<major>[0-9]+)-(?<minor>[0-9]+)(-(?<patch>[0-9]+))?")?) as $match
        | [
            (($match.major // "0") | tonumber),
            (($match.minor // "0") | tonumber),
            (($match.patch // "0") | tonumber)
          ];
      def preference_rank($name):
        ($preferred | index($name)) // 999;
      def runtime_score($version):
        ($version[0] * 10000) + ($version[1] * 100) + $version[2];
      [
        .devices
        | to_entries[]
        | select(.key | test("com\\.apple\\.CoreSimulator\\.SimRuntime\\.iOS-"))
        | . as $runtime_entry
        | .value[]
        | select(.isAvailable == true)
        | {
            runtime: $runtime_entry.key,
            runtimeVersion: runtime_version($runtime_entry.key),
            name,
            udid,
            state,
            deviceTypeIdentifier,
            isPhone: (.name | startswith("iPhone"))
          }
      ] as $devices
      | if ($devices | length) == 0 then
          { error: "No available iOS simulator devices are installed yet." }
        elif ($requestedUdid | length) > 0 then
          (
            $devices
            | map(select(.udid == $requestedUdid))
            | sort_by((.state != "Booted"), (.isPhone | not), preference_rank(.name), -runtime_score(.runtimeVersion), .name)
            | first
          ) // { error: ("Requested iOS simulator UDID not found: " + $requestedUdid) }
        elif ($requestedSim | length) > 0 then
          (
            $devices
            | map(select((.udid | ascii_downcase) == ($requestedSim | ascii_downcase) or (.name | ascii_downcase) == ($requestedSim | ascii_downcase)))
            | sort_by((.state != "Booted"), (.isPhone | not), preference_rank(.name), -runtime_score(.runtimeVersion), .name)
            | first
          ) // { error: ("Requested iOS simulator not found: " + $requestedSim) }
        else
          (
            $devices
            | sort_by((.state != "Booted"), (.isPhone | not), preference_rank(.name), -runtime_score(.runtimeVersion), .name)
            | first
          )
        end
    '
)"

selection_error="$(printf '%s' "${selected_json}" | jq -r '.error // empty')"
if [[ -n "${selection_error}" ]]; then
  echo "${selection_error}" >&2
  exit 1
fi

name="$(printf '%s' "${selected_json}" | jq -r '.name')"
udid="$(printf '%s' "${selected_json}" | jq -r '.udid')"
runtime="$(printf '%s' "${selected_json}" | jq -r '.runtime')"
state="$(printf '%s' "${selected_json}" | jq -r '.state')"

if [[ -z "${requested_dest}" ]]; then
  destination="platform=iOS Simulator,id=${udid}"
else
  destination="${requested_dest}"
fi

case "${mode}" in
  destination)
    printf '%s\n' "${destination}"
    ;;
  name)
    printf '%s\n' "${name}"
    ;;
  udid)
    printf '%s\n' "${udid}"
    ;;
  json)
    jq -n \
      --arg destination "${destination}" \
      --arg name "${name}" \
      --arg udid "${udid}" \
      --arg runtime "${runtime}" \
      --arg state "${state}" \
      '{
        destination: $destination,
        name: $name,
        udid: $udid,
        runtime: $runtime,
        state: $state
      }'
    ;;
  shell)
    printf 'export IOS_DEST=%q\n' "${destination}"
    printf 'export IOS_SIM=%q\n' "${name}"
    printf 'export IOS_SIM_NAME=%q\n' "${name}"
    printf 'export IOS_SIM_UDID=%q\n' "${udid}"
    printf 'export IOS_SIM_RUNTIME=%q\n' "${runtime}"
    printf 'export IOS_SIM_STATE=%q\n' "${state}"
    ;;
esac
