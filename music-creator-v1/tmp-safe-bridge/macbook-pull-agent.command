#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="${0:A:h}"
REQUEST_DIR="${BRIDGE_ROOT}/to-macbook/requests"
PROCESSED_DIR="${REQUEST_DIR}/processed"
REJECTED_DIR="${REQUEST_DIR}/rejected"
RESULTS_DIR="${BRIDGE_ROOT}/from-macbook/agent-results"
STATUS_DIR="${BRIDGE_ROOT}/from-macbook"
LOG_DIR="${BRIDGE_ROOT}/logs"
STATUS_FILE="${STATUS_DIR}/macbook-pull-agent-status.json"
LOG_FILE="${LOG_DIR}/macbook-pull-agent.log"
PUBLIC_KEY_FILE="${BRIDGE_ROOT}/macstudio-bridge-signing.pub.pem"
INTERVAL_SECONDS="${OPENCLAW_BRIDGE_AGENT_INTERVAL:-10}"
MODE="${1:-loop}"
ALLOWED_ACTIONS="health-check, garageband-status, list-bridge-files, open-latest-bridge-job, open-bridge-job"

mkdir -p "${REQUEST_DIR}" "${PROCESSED_DIR}" "${REJECTED_DIR}" "${RESULTS_DIR}" "${LOG_DIR}"
exec > >(tee -a "${LOG_FILE}") 2>&1

json_escape() {
  printf "%s" "$1" | /usr/bin/sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

json_value() {
  /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null | /usr/bin/tr -d '\n' || true
}

safe_id() {
  [[ "$1" =~ '^[A-Za-z0-9._:-]+$' ]]
}

allowed_action() {
  case "$1" in
    health-check|garageband-status|list-bridge-files|open-latest-bridge-job|open-bridge-job) return 0 ;;
    *) return 1 ;;
  esac
}

write_agent_status() {
  local agent_status="$1"
  local detail="$2"
  local remote_login
  remote_login="$(/usr/sbin/systemsetup -getremotelogin 2>/dev/null | /usr/bin/tr -d '\n' || true)"
  cat > "${STATUS_FILE}" <<JSON
{
  "schemaVersion": 1,
  "status": "${agent_status}",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "mode": "${MODE}",
  "allowedActions": "${ALLOWED_ACTIONS}",
  "remoteLoginUsed": false,
  "remoteLoginState": "$(json_escape "${remote_login}")",
  "detail": "$(json_escape "${detail}")",
  "nextAction": "Mac Studio can queue signed jobs with bridge-queue-job. Close this Terminal window to stop the agent."
}
JSON
}

write_result() {
  local request_id="$1"
  local action="$2"
  local result_status="$3"
  local detail="$4"
  local result_file="${RESULTS_DIR}/${request_id}.json"
  cat > "${result_file}" <<JSON
{
  "schemaVersion": 1,
  "requestId": "$(json_escape "${request_id}")",
  "action": "$(json_escape "${action}")",
  "status": "$(json_escape "${result_status}")",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "remoteLoginUsed": false,
  "arbitraryCommandsAllowed": false,
  "detail": "$(json_escape "${detail}")"
}
JSON
}

reject_request() {
  local job_file="$1"
  local reason="$2"
  local base="${job_file:t}"
  local request_id="${base:r}"
  write_result "${request_id}" "unknown" "rejected" "${reason}"
  mv "${job_file}" "${REJECTED_DIR}/${base}" 2>/dev/null || true
  if [[ -f "${job_file}.sig" ]]; then
    mv "${job_file}.sig" "${REJECTED_DIR}/${base}.sig" 2>/dev/null || true
  fi
  echo "Rejected ${base}: ${reason}"
}

first_audio_in_job() {
  local job_dir="$1"
  /usr/bin/find "${job_dir}/audio" -maxdepth 1 -type f \( -iname "*.wav" -o -iname "*.aif" -o -iname "*.aiff" -o -iname "*.mp3" -o -iname "*.m4a" -o -iname "*.flac" -o -iname "*.ogg" \) -print -quit 2>/dev/null
}

open_job_audio() {
  local request_id="$1"
  local action="$2"
  local job_id="$3"
  if ! safe_id "${job_id}"; then
    write_result "${request_id}" "${action}" "blocked" "Unsafe or missing bridge job id."
    return 1
  fi
  local job_dir="${BRIDGE_ROOT}/to-macbook/${job_id}"
  local audio_file
  audio_file="$(first_audio_in_job "${job_dir}")"
  if [[ -z "${audio_file}" || ! -f "${audio_file}" ]]; then
    write_result "${request_id}" "${action}" "blocked" "No audio file found for bridge job ${job_id}."
    return 1
  fi
  /usr/bin/open -a GarageBand || true
  /usr/bin/open -R "${audio_file}"
  write_result "${request_id}" "${action}" "done" "GarageBand open request handled for bridge job ${job_id}; Finder revealed the audio file."
}

handle_action() {
  local job_file="$1"
  local request_id="$2"
  local action="$3"
  case "${action}" in
    health-check)
      local computer_name
      computer_name="$(scutil --get ComputerName 2>/dev/null | /usr/bin/tr -d '\n' || hostname)"
      write_result "${request_id}" "${action}" "done" "MacBook pull agent healthy on ${computer_name}. Remote Login is not used."
      ;;
    garageband-status)
      local garageband_status="missing"
      if [[ -d "/Applications/GarageBand.app" || -d "/System/Applications/GarageBand.app" ]]; then
        garageband_status="installed"
      fi
      local au_status="not_checked"
      if command -v auval >/dev/null 2>&1; then
        if auval -v aufx sMas oDin > "${LOG_DIR}/pull-agent-auval.txt" 2>&1; then
          au_status="valhalla_au_passed"
        else
          au_status="valhalla_au_missing_or_failed"
        fi
      fi
      write_result "${request_id}" "${action}" "done" "GarageBand: ${garageband_status}; Valhalla AU: ${au_status}."
      ;;
    list-bridge-files)
      /usr/bin/find "${BRIDGE_ROOT}/to-macbook" -maxdepth 2 -type f 2>/dev/null | /usr/bin/sed "s#${BRIDGE_ROOT}/##" | /usr/bin/head -n 200 > "${LOG_DIR}/pull-agent-bridge-files.txt" || true
      write_result "${request_id}" "${action}" "done" "Wrote bridge file listing to logs/pull-agent-bridge-files.txt."
      ;;
    open-latest-bridge-job)
      local latest_job
      latest_job="$(ls -td "${BRIDGE_ROOT}"/to-macbook/*(/N) 2>/dev/null | /usr/bin/grep -v '/requests$' | /usr/bin/head -n 1 || true)"
      if [[ -z "${latest_job}" ]]; then
        write_result "${request_id}" "${action}" "blocked" "No bridge jobs found."
        return 1
      fi
      open_job_audio "${request_id}" "${action}" "${latest_job:t}"
      ;;
    open-bridge-job)
      local job_id
      job_id="$(json_value "${job_file}" "target.jobId")"
      open_job_audio "${request_id}" "${action}" "${job_id}"
      ;;
  esac
}

process_request() {
  local job_file="$1"
  local sig_file="${job_file}.sig"
  local base="${job_file:t}"
  if [[ ! -s "${PUBLIC_KEY_FILE}" ]]; then
    reject_request "${job_file}" "Missing Mac Studio signing public key."
    return
  fi
  if [[ ! -s "${sig_file}" ]]; then
    reject_request "${job_file}" "Missing request signature."
    return
  fi
  if ! /usr/bin/openssl dgst -sha256 -verify "${PUBLIC_KEY_FILE}" -signature "${sig_file}" "${job_file}" >/dev/null 2>&1; then
    reject_request "${job_file}" "Request signature did not verify."
    return
  fi

  local request_id action expires_at now
  request_id="$(json_value "${job_file}" "requestId")"
  action="$(json_value "${job_file}" "action")"
  expires_at="$(json_value "${job_file}" "expiresAt")"
  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  if ! safe_id "${request_id}"; then
    reject_request "${job_file}" "Unsafe or missing request id."
    return
  fi
  if ! allowed_action "${action}"; then
    reject_request "${job_file}" "Action is not whitelisted."
    return
  fi
  if [[ -n "${expires_at}" && "${expires_at}" < "${now}" ]]; then
    reject_request "${job_file}" "Request expired."
    return
  fi

  write_agent_status "processing" "${request_id} ${action}"
  if handle_action "${job_file}" "${request_id}" "${action}"; then
    mv "${job_file}" "${PROCESSED_DIR}/${base}" 2>/dev/null || true
    mv "${sig_file}" "${PROCESSED_DIR}/${base}.sig" 2>/dev/null || true
    echo "Processed ${request_id}: ${action}"
  else
    mv "${job_file}" "${REJECTED_DIR}/${base}" 2>/dev/null || true
    mv "${sig_file}" "${REJECTED_DIR}/${base}.sig" 2>/dev/null || true
    echo "Blocked ${request_id}: ${action}"
  fi
}

process_once() {
  local found=false
  for job_file in "${REQUEST_DIR}"/*.json(N); do
    found=true
    process_request "${job_file}"
  done
  if [[ "${found}" == false ]]; then
    write_agent_status "idle" "No signed requests waiting."
    echo "No signed requests waiting."
  fi
}

write_agent_status "started" "MacBook pull agent started. Remote Login is not used."
if [[ "${MODE}" == "--once" || "${MODE}" == "once" ]]; then
  process_once
  write_agent_status "stopped" "One-shot run complete."
else
  echo "MacBook pull agent running. Allowed actions: ${ALLOWED_ACTIONS}"
  echo "Close this Terminal window to stop it."
  while true; do
    process_once
    sleep "${INTERVAL_SECONDS}"
  done
fi
