#!/usr/bin/env bash
set -u

PROOF_DIR="${PROOF_DIR:-}"
LATEST_PROOF="${LATEST_PROOF:-}"
GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:18789}"

mkdir -p "${PROOF_DIR}"
mkdir -p "${PROOF_DIR}/luna_tests"
mkdir -p "${PROOF_DIR}/gateway"
BLOCKER_PATH="${PROOF_DIR}/BLOCKER.md"

write_blocker() {
  local step="$1"
  local exit_code="$2"
  local http_code="$3"
  local note="$4"
  cat > "${BLOCKER_PATH}" <<EOF_INNER
Step failed: ${step}

Exit code: ${exit_code}
HTTP code: ${http_code}
Log files:
- ${PROOF_DIR}/luna_tests/${step}.log
- ${PROOF_DIR}/luna_tests/quicktests_run.log

Details:
${note}

Next action:
- Review the logs above and retry quicktests after gateway readiness or timeout adjustments.
EOF_INNER
}

if [[ -z "${PROOF_DIR}" ]]; then
  write_blocker "preflight" 2 "" "PROOF_DIR is required."
  exit 2
fi

if [[ -z "${LATEST_PROOF}" ]]; then
  write_blocker "preflight" 2 "" "LATEST_PROOF is required."
  exit 2
fi

log_step() {
  local name="$1"
  local message="$2"
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] ${name}: ${message}" >> "${PROOF_DIR}/luna_tests/quicktests_run.log"
}

write_summary() {
  local json="$1"
  echo "${json}" > "${PROOF_DIR}/luna_tests/quicktests_summary.json"
}

build_gateway_image() {
  local log="${PROOF_DIR}/luna_tests/gateway_build.log"
  if [[ "${OPENCLAW_BUILD_GATEWAY:-1}" != "1" ]]; then
    echo "skipped:OPENCLAW_BUILD_GATEWAY=${OPENCLAW_BUILD_GATEWAY:-0}" > "${log}"
    echo "0" > "${PROOF_DIR}/luna_tests/gateway_build.exitcode"
    return 0
  fi
  log_step "gateway_build" "start"
  docker compose build openclaw-gateway > "${log}" 2>&1
  local code=$?
  echo "${code}" > "${PROOF_DIR}/luna_tests/gateway_build.exitcode"
  if [[ "${code}" -ne 0 ]]; then
    write_blocker "gateway_build" "${code}" "" "docker compose build openclaw-gateway failed."
    return 1
  fi
  log_step "gateway_build" "ok"
  return 0
}

wait_gateway_ready() {
  local url="${GATEWAY_URL}/__openclaw__/canvas/"
  local max_wait_sec=90
  local waited=0
  : > "${PROOF_DIR}/luna_tests/gateway_wait.log"
  while [[ "${waited}" -lt "${max_wait_sec}" ]]; do
    local http_code="000"
    local exit_code=0
    http_code=$(curl -sS --connect-timeout 2 --max-time 3 -o /dev/null -w "%{http_code}" "${url}")
    exit_code=$?
    echo "ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ") attempt=${waited} exit=${exit_code} http=${http_code}" >> "${PROOF_DIR}/luna_tests/gateway_wait.log"
    if [[ "${http_code}" =~ ^(200|204|302|401|403|404)$ ]]; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

curl_tool_call() {
  local name="$1"
  local request_file="$2"
  local response_file="$3"
  local http_file="$4"
  local log_file="$5"
  local max_attempts=8
  local attempt=1
  local backoff=1
  local start_time
  start_time=$(date +%s)
  while [[ "${attempt}" -le "${max_attempts}" ]]; do
    curl -sS --connect-timeout 20 --max-time 120 \
      -H "content-type: application/json" \
      -H "authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}" \
      --data-binary @"${request_file}" \
      -w "%{http_code}" \
      -o "${response_file}" \
      "${GATEWAY_URL}/tools/invoke" > "${http_file}" 2>> "${log_file}"
    local exit_code=$?
    local http_code
    http_code="$(cat "${http_file}" 2>/dev/null || echo 000)"
    if [[ "${exit_code}" -eq 0 && "${http_code}" != "000" ]]; then
      return 0
    fi
    local now
    now=$(date +%s)
    if [[ $((now - start_time)) -ge 120 ]]; then
      return 1
    fi
    sleep "${backoff}"
    if [[ "${backoff}" -lt 10 ]]; then
      backoff=$((backoff * 2))
      if [[ "${backoff}" -gt 10 ]]; then
        backoff=10
      fi
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

extract_confirm_token() {
  local file="$1"
  node -e "const fs=require('fs');const raw=fs.readFileSync(process.argv[1],'utf8');const res=JSON.parse(raw);const text=res?.result?.content?.[0]?.text; if(!text){process.exit(1)}; let parsed=null; try{parsed=JSON.parse(text);}catch{process.exit(1)}; const token=parsed.confirm_token||parsed.token||\"\"; if(!token){process.exit(1)}; console.log(token);" "$file"
}

load_gateway_token() {
  if [[ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
    return 0
  fi
  if [[ -f "/home/dado/openclaw/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "/home/dado/openclaw/.env"
    set +a
  fi
  if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
    echo "OPENCLAW_GATEWAY_TOKEN is required" >&2
    return 1
  fi
  return 0
}

run_step() {
  local name="$1"
  local command="$2"
  local log="${PROOF_DIR}/luna_tests/${name}.log"
  log_step "${name}" "start"
  bash -lc "${command}" > "${log}" 2>&1
  local code=$?
  echo "${code}" > "${PROOF_DIR}/luna_tests/${name}.exitcode"
  if [[ "${code}" -ne 0 ]]; then
    log_step "${name}" "fail (${code})"
  else
    log_step "${name}" "ok"
  fi
  return "${code}"
}

candidate_select_cmd="PROOF_DIR=\"${PROOF_DIR}\" LATEST_PROOF=\"${LATEST_PROOF}\" node /home/dado/openclaw/scripts/luna_candidate_select.mjs"
candidate_read_cmd="node /home/dado/openclaw/scripts/luna_candidate_read.mjs \"${PROOF_DIR}/luna_tests/candidate_entities.json\""

run_step "candidate_select" "${candidate_select_cmd}"
candidate_select_code=$?

run_step "candidate_read" "${candidate_read_cmd}"
candidate_read_code=$?

LIGHT=""
FAN=""
OUTLET=""
VACUUM=""
CLIMATE=""
LOCK=""
if [[ -f "${PROOF_DIR}/luna_tests/candidate_read.log" ]]; then
  read -r LIGHT FAN OUTLET VACUUM CLIMATE LOCK < "${PROOF_DIR}/luna_tests/candidate_read.log" || true
  echo "${LIGHT} ${FAN} ${OUTLET} ${VACUUM} ${CLIMATE} ${LOCK}" > "${PROOF_DIR}/luna_tests/candidate_entities_parsed.txt"
fi

ha_ping_code=1
ha_light_code=1
ha_fan_code=1
ha_outlet_code=1
ha_vacuum_code=1
ha_climate_code=1
ha_plan_action_code=1
ha_prepare_missing_code=1
ha_prepare_confirm_code=1
ha_confirm_action_code=1
ha_policy_get_code=1
ha_policy_explain_vacuum_code=1
ha_policy_explain_climate_code=1
ha_policy_explain_lock_code=1
confirm_token=""
ha_ping_http="0"
ha_light_http=""
ha_fan_http=""
ha_outlet_http=""
ha_vacuum_http=""
ha_climate_http=""
ha_plan_action_http=""
ha_prepare_missing_http=""
ha_prepare_confirm_http=""
ha_confirm_action_http=""
ha_policy_get_http=""
ha_policy_explain_vacuum_http=""
ha_policy_explain_climate_http=""
ha_policy_explain_lock_http=""

if ! build_gateway_image; then
  exit 1
fi

if ! wait_gateway_ready; then
  write_blocker "gateway_wait" 1 000 "Gateway did not respond with a ready HTTP code within 90s."
  exit 1
fi

if load_gateway_token; then
  echo "{\"tool\":\"ha_ping\",\"args\":{},\"sessionKey\":\"main\"}" > "${PROOF_DIR}/luna_tests/ha_ping_request.json"
  curl_tool_call "ha_ping" \
    "${PROOF_DIR}/luna_tests/ha_ping_request.json" \
    "${PROOF_DIR}/luna_tests/ha_ping.json" \
    "${PROOF_DIR}/luna_tests/ha_ping.http" \
    "${PROOF_DIR}/luna_tests/ha_ping.log"
  ha_ping_code=$?
  ha_ping_http="$(cat "${PROOF_DIR}/luna_tests/ha_ping.http" 2>/dev/null || echo 0)"
  echo "${ha_ping_code}" > "${PROOF_DIR}/luna_tests/ha_ping.exitcode"

  echo "{\"tool\":\"ha_risk_policy_get\",\"args\":{},\"sessionKey\":\"main\"}" > "${PROOF_DIR}/luna_tests/ha_risk_policy_get_request.json"
  curl_tool_call "ha_risk_policy_get" \
    "${PROOF_DIR}/luna_tests/ha_risk_policy_get_request.json" \
    "${PROOF_DIR}/luna_tests/ha_risk_policy_get.json" \
    "${PROOF_DIR}/luna_tests/ha_risk_policy_get.http" \
    "${PROOF_DIR}/luna_tests/ha_risk_policy_get.log"
  ha_policy_get_code=$?
  ha_policy_get_http="$(cat "${PROOF_DIR}/luna_tests/ha_risk_policy_get.http" 2>/dev/null || echo 0)"
  echo "${ha_policy_get_code}" > "${PROOF_DIR}/luna_tests/ha_risk_policy_get.exitcode"

  echo "{\"tool\":\"ha_plan_action\",\"args\":{\"user_intent\":\"inventar izvještaj NEEDS_OVERRIDE\"},\"sessionKey\":\"main\"}" > "${PROOF_DIR}/luna_tests/ha_plan_action_request.json"
  curl_tool_call "ha_plan_action" \
    "${PROOF_DIR}/luna_tests/ha_plan_action_request.json" \
    "${PROOF_DIR}/luna_tests/ha_plan_action.json" \
    "${PROOF_DIR}/luna_tests/ha_plan_action.http" \
    "${PROOF_DIR}/luna_tests/ha_plan_action.log"
  ha_plan_action_code=$?
  ha_plan_action_http="$(cat "${PROOF_DIR}/luna_tests/ha_plan_action.http" 2>/dev/null || echo 0)"
  echo "${ha_plan_action_code}" > "${PROOF_DIR}/luna_tests/ha_plan_action.exitcode"

  echo "{\"tool\":\"ha_prepare_risky_action\",\"args\":{\"kind\":\"service_call\",\"reason\":\"missing_action_test\"},\"sessionKey\":\"main\"}" > "${PROOF_DIR}/luna_tests/ha_prepare_risky_action_missing_request.json"
  curl_tool_call "ha_prepare_risky_action_missing" \
    "${PROOF_DIR}/luna_tests/ha_prepare_risky_action_missing_request.json" \
    "${PROOF_DIR}/luna_tests/ha_prepare_risky_action_missing.json" \
    "${PROOF_DIR}/luna_tests/ha_prepare_risky_action_missing.http" \
    "${PROOF_DIR}/luna_tests/ha_prepare_risky_action_missing.log"
  ha_prepare_missing_code=$?
  ha_prepare_missing_http="$(cat "${PROOF_DIR}/luna_tests/ha_prepare_risky_action_missing.http" 2>/dev/null || echo 0)"
  echo "${ha_prepare_missing_code}" > "${PROOF_DIR}/luna_tests/ha_prepare_risky_action_missing.exitcode"

  echo "{\"tool\":\"ha_prepare_risky_action\",\"args\":{\"kind\":\"service_call\",\"action\":{\"domain\":\"persistent_notification\",\"service\":\"create\",\"data\":{\"title\":\"OpenClaw Engineer Mode\",\"message\":\"Risky action confirm test\",\"notification_id\":\"openclaw_engineer_mode_test\"}}},\"sessionKey\":\"main\"}" > "${PROOF_DIR}/luna_tests/ha_prepare_risky_action_request.json"
  curl_tool_call "ha_prepare_risky_action" \
    "${PROOF_DIR}/luna_tests/ha_prepare_risky_action_request.json" \
    "${PROOF_DIR}/luna_tests/ha_prepare_risky_action.json" \
    "${PROOF_DIR}/luna_tests/ha_prepare_risky_action.http" \
    "${PROOF_DIR}/luna_tests/ha_prepare_risky_action.log"
  ha_prepare_confirm_code=$?
  ha_prepare_confirm_http="$(cat "${PROOF_DIR}/luna_tests/ha_prepare_risky_action.http" 2>/dev/null || echo 0)"
  echo "${ha_prepare_confirm_code}" > "${PROOF_DIR}/luna_tests/ha_prepare_risky_action.exitcode"

  confirm_token=""
  if confirm_token="$(extract_confirm_token "${PROOF_DIR}/luna_tests/ha_prepare_risky_action.json" 2>/dev/null)"; then
    echo "${confirm_token}" > "${PROOF_DIR}/luna_tests/ha_confirm_action.token"
    echo "{\"tool\":\"ha_confirm_action\",\"args\":{\"token\":\"${confirm_token}\"},\"sessionKey\":\"main\"}" > "${PROOF_DIR}/luna_tests/ha_confirm_action_request.json"
    curl_tool_call "ha_confirm_action" \
      "${PROOF_DIR}/luna_tests/ha_confirm_action_request.json" \
      "${PROOF_DIR}/luna_tests/ha_confirm_action.json" \
      "${PROOF_DIR}/luna_tests/ha_confirm_action.http" \
      "${PROOF_DIR}/luna_tests/ha_confirm_action.log"
    ha_confirm_action_code=$?
    ha_confirm_action_http="$(cat "${PROOF_DIR}/luna_tests/ha_confirm_action.http" 2>/dev/null || echo 0)"
    echo "${ha_confirm_action_code}" > "${PROOF_DIR}/luna_tests/ha_confirm_action.exitcode"
  else
    ha_confirm_action_code=0
    echo "skipped:no_confirm_token" > "${PROOF_DIR}/luna_tests/ha_confirm_action.log"
  fi

  if [[ -n "${LIGHT}" ]]; then
    echo "{\"tool\":\"ha_universal_control\",\"args\":{\"target\":{\"entity_id\":\"${LIGHT}\"},\"safe_probe\":true},\"sessionKey\":\"main\"}" > "${PROOF_DIR}/luna_tests/ha_uc_light_request.json"
    curl_tool_call "ha_uc_light" \
      "${PROOF_DIR}/luna_tests/ha_uc_light_request.json" \
      "${PROOF_DIR}/luna_tests/ha_uc_light.json" \
      "${PROOF_DIR}/luna_tests/ha_uc_light.http" \
      "${PROOF_DIR}/luna_tests/ha_uc_light.log"
    ha_light_code=$?
    ha_light_http="$(cat "${PROOF_DIR}/luna_tests/ha_uc_light.http" 2>/dev/null || echo 0)"
    echo "${ha_light_code}" > "${PROOF_DIR}/luna_tests/ha_uc_light.exitcode"
  else
    ha_light_code=0
    echo "skipped:no_candidate" > "${PROOF_DIR}/luna_tests/ha_uc_light.log"
  fi

  if [[ -n "${FAN}" ]]; then
    echo "{\"tool\":\"ha_universal_control\",\"args\":{\"target\":{\"entity_id\":\"${FAN}\"},\"safe_probe\":true},\"sessionKey\":\"main\"}" > "${PROOF_DIR}/luna_tests/ha_uc_fan_request.json"
    curl_tool_call "ha_uc_fan" \
      "${PROOF_DIR}/luna_tests/ha_uc_fan_request.json" \
      "${PROOF_DIR}/luna_tests/ha_uc_fan.json" \
      "${PROOF_DIR}/luna_tests/ha_uc_fan.http" \
      "${PROOF_DIR}/luna_tests/ha_uc_fan.log"
    ha_fan_code=$?
    ha_fan_http="$(cat "${PROOF_DIR}/luna_tests/ha_uc_fan.http" 2>/dev/null || echo 0)"
    echo "${ha_fan_code}" > "${PROOF_DIR}/luna_tests/ha_uc_fan.exitcode"
  else
    ha_fan_code=0
    echo "skipped:no_candidate" > "${PROOF_DIR}/luna_tests/ha_uc_fan.log"
  fi

  if [[ -n "${OUTLET}" ]]; then
    echo "{\"tool\":\"ha_universal_control\",\"args\":{\"target\":{\"entity_id\":\"${OUTLET}\"},\"safe_probe\":true},\"sessionKey\":\"main\"}" > "${PROOF_DIR}/luna_tests/ha_uc_outlet_request.json"
    curl_tool_call "ha_uc_outlet" \
      "${PROOF_DIR}/luna_tests/ha_uc_outlet_request.json" \
      "${PROOF_DIR}/luna_tests/ha_uc_outlet.json" \
      "${PROOF_DIR}/luna_tests/ha_uc_outlet.http" \
      "${PROOF_DIR}/luna_tests/ha_uc_outlet.log"
    ha_outlet_code=$?
    ha_outlet_http="$(cat "${PROOF_DIR}/luna_tests/ha_uc_outlet.http" 2>/dev/null || echo 0)"
    echo "${ha_outlet_code}" > "${PROOF_DIR}/luna_tests/ha_uc_outlet.exitcode"
  else
    ha_outlet_code=0
    echo "skipped:no_candidate" > "${PROOF_DIR}/luna_tests/ha_uc_outlet.log"
  fi

  if [[ -n "${VACUUM}" ]]; then
    echo "{\"tool\":\"ha_risk_policy_explain\",\"args\":{\"target\":{\"entity_id\":\"${VACUUM}\"},\"intent\":{\"action\":\"start\"}},\"sessionKey\":\"main\"}" > "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_vacuum_request.json"
    curl_tool_call "ha_risk_policy_explain_vacuum" \
      "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_vacuum_request.json" \
      "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_vacuum.json" \
      "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_vacuum.http" \
      "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_vacuum.log"
    ha_policy_explain_vacuum_code=$?
    ha_policy_explain_vacuum_http="$(cat "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_vacuum.http" 2>/dev/null || echo 0)"
    echo "${ha_policy_explain_vacuum_code}" > "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_vacuum.exitcode"

    echo "{\"tool\":\"ha_universal_control\",\"args\":{\"target\":{\"entity_id\":\"${VACUUM}\"},\"safe_probe\":true},\"sessionKey\":\"main\"}" > "${PROOF_DIR}/luna_tests/ha_uc_vacuum_request.json"
    curl_tool_call "ha_uc_vacuum" \
      "${PROOF_DIR}/luna_tests/ha_uc_vacuum_request.json" \
      "${PROOF_DIR}/luna_tests/ha_uc_vacuum.json" \
      "${PROOF_DIR}/luna_tests/ha_uc_vacuum.http" \
      "${PROOF_DIR}/luna_tests/ha_uc_vacuum.log"
    ha_vacuum_code=$?
    ha_vacuum_http="$(cat "${PROOF_DIR}/luna_tests/ha_uc_vacuum.http" 2>/dev/null || echo 0)"
    echo "${ha_vacuum_code}" > "${PROOF_DIR}/luna_tests/ha_uc_vacuum.exitcode"
  else
    ha_policy_explain_vacuum_code=0
    ha_vacuum_code=0
    echo "skipped:no_candidate" > "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_vacuum.log"
    echo "skipped:no_candidate" > "${PROOF_DIR}/luna_tests/ha_uc_vacuum.log"
  fi

  if [[ -n "${CLIMATE}" ]]; then
    echo "{\"tool\":\"ha_risk_policy_explain\",\"args\":{\"target\":{\"entity_id\":\"${CLIMATE}\"},\"intent\":{\"action\":\"set_temperature\",\"property\":\"temperature\",\"value\":22}},\"sessionKey\":\"main\"}" > "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_climate_request.json"
    curl_tool_call "ha_risk_policy_explain_climate" \
      "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_climate_request.json" \
      "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_climate.json" \
      "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_climate.http" \
      "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_climate.log"
    ha_policy_explain_climate_code=$?
    ha_policy_explain_climate_http="$(cat "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_climate.http" 2>/dev/null || echo 0)"
    echo "${ha_policy_explain_climate_code}" > "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_climate.exitcode"

    echo "{\"tool\":\"ha_universal_control\",\"args\":{\"target\":{\"entity_id\":\"${CLIMATE}\"},\"safe_probe\":true},\"sessionKey\":\"main\"}" > "${PROOF_DIR}/luna_tests/ha_uc_climate_request.json"
    curl_tool_call "ha_uc_climate" \
      "${PROOF_DIR}/luna_tests/ha_uc_climate_request.json" \
      "${PROOF_DIR}/luna_tests/ha_uc_climate.json" \
      "${PROOF_DIR}/luna_tests/ha_uc_climate.http" \
      "${PROOF_DIR}/luna_tests/ha_uc_climate.log"
    ha_climate_code=$?
    ha_climate_http="$(cat "${PROOF_DIR}/luna_tests/ha_uc_climate.http" 2>/dev/null || echo 0)"
    echo "${ha_climate_code}" > "${PROOF_DIR}/luna_tests/ha_uc_climate.exitcode"
  else
    ha_policy_explain_climate_code=0
    ha_climate_code=0
    echo "skipped:no_candidate" > "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_climate.log"
    echo "skipped:no_candidate" > "${PROOF_DIR}/luna_tests/ha_uc_climate.log"
  fi

  if [[ -n "${LOCK}" ]]; then
    echo "{\"tool\":\"ha_risk_policy_explain\",\"args\":{\"target\":{\"entity_id\":\"${LOCK}\"},\"intent\":{\"action\":\"unlock\"}},\"sessionKey\":\"main\"}" > "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_lock_request.json"
    curl_tool_call "ha_risk_policy_explain_lock" \
      "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_lock_request.json" \
      "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_lock.json" \
      "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_lock.http" \
      "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_lock.log"
    ha_policy_explain_lock_code=$?
    ha_policy_explain_lock_http="$(cat "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_lock.http" 2>/dev/null || echo 0)"
    echo "${ha_policy_explain_lock_code}" > "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_lock.exitcode"
  else
    ha_policy_explain_lock_code=0
    echo "skipped:no_candidate" > "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_lock.log"
  fi
else
  echo "Failed to load OPENCLAW_GATEWAY_TOKEN" > "${PROOF_DIR}/luna_tests/token_load.log"
fi

plan_route_ok=false
if [[ -f "${PROOF_DIR}/luna_tests/ha_plan_action.json" ]]; then
  if node -e "const fs=require('fs');const raw=fs.readFileSync(process.argv[1],'utf8');const res=JSON.parse(raw);const text=res?.result?.content?.[0]?.text||'';let parsed=null;try{parsed=JSON.parse(text);}catch{};process.exit(parsed?.route==='inventory_report'?0:1);" "${PROOF_DIR}/luna_tests/ha_plan_action.json"; then
    plan_route_ok=true
  fi
fi
missing_action_ok=false
if [[ -f "${PROOF_DIR}/luna_tests/ha_prepare_risky_action_missing.json" ]]; then
  if node -e "const fs=require('fs');const raw=fs.readFileSync(process.argv[1],'utf8');const res=JSON.parse(raw);const text=res?.result?.content?.[0]?.text||'';let parsed=null;try{parsed=JSON.parse(text);}catch{};process.exit(parsed?.error==='missing_action'?0:1);" "${PROOF_DIR}/luna_tests/ha_prepare_risky_action_missing.json"; then
    missing_action_ok=true
  fi
fi

cp "${PROOF_DIR}/luna_tests/ha_risk_policy_get.json" "${PROOF_DIR}/luna_tests/policy_dump.json" 2>/dev/null || true
vacuum_explain_payload="null"
climate_explain_payload="null"
lock_explain_payload="null"
if [[ -f "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_vacuum.json" ]]; then
  vacuum_explain_payload="$(cat "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_vacuum.json")"
fi
if [[ -f "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_climate.json" ]]; then
  climate_explain_payload="$(cat "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_climate.json")"
fi
if [[ -f "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_lock.json" ]]; then
  lock_explain_payload="$(cat "${PROOF_DIR}/luna_tests/ha_risk_policy_explain_lock.json")"
fi
cat > "${PROOF_DIR}/luna_tests/policy_explain_samples.json" <<EOF_INNER
{
  "vacuum": ${vacuum_explain_payload},
  "climate": ${climate_explain_payload},
  "lock": ${lock_explain_payload}
}
EOF_INNER

summary=$(cat <<EOF_INNER
{
  "candidate_select": { "ok": $( [[ "${candidate_select_code}" -eq 0 ]] && echo true || echo false ), "exit_code": ${candidate_select_code}, "log": "luna_tests/candidate_select.log" },
  "candidate_read": { "ok": $( [[ "${candidate_read_code}" -eq 0 ]] && echo true || echo false ), "exit_code": ${candidate_read_code}, "log": "luna_tests/candidate_read.log" },
  "ha_ping": { "ok": $( [[ "${ha_ping_code}" -eq 0 && "${ha_ping_http}" -ge 200 && "${ha_ping_http}" -lt 300 ]] && echo true || echo false ), "exit_code": ${ha_ping_code}, "http_code": "${ha_ping_http}" },
  "ha_plan_action_inventory": { "ok": $( [[ "${ha_plan_action_code}" -eq 0 && "${ha_plan_action_http}" -ge 200 && "${ha_plan_action_http}" -lt 300 && "${plan_route_ok}" == "true" ]] && echo true || echo false ), "exit_code": ${ha_plan_action_code}, "http_code": "${ha_plan_action_http}" },
  "ha_prepare_risky_action_missing": { "ok": $( [[ "${ha_prepare_missing_code}" -eq 0 && "${ha_prepare_missing_http}" -ge 200 && "${ha_prepare_missing_http}" -lt 300 && "${missing_action_ok}" == "true" ]] && echo true || echo false ), "exit_code": ${ha_prepare_missing_code}, "http_code": "${ha_prepare_missing_http}" },
  "ha_prepare_risky_action": { "ok": $( [[ "${ha_prepare_confirm_code}" -eq 0 && "${ha_prepare_confirm_http}" -ge 200 && "${ha_prepare_confirm_http}" -lt 300 ]] && echo true || echo false ), "exit_code": ${ha_prepare_confirm_code}, "http_code": "${ha_prepare_confirm_http}" },
  "ha_confirm_action": { "ok": $( [[ -n "${confirm_token}" && "${ha_confirm_action_code}" -eq 0 && "${ha_confirm_action_http}" -ge 200 && "${ha_confirm_action_http}" -lt 300 ]] && echo true || echo false ), "exit_code": ${ha_confirm_action_code}, "http_code": "${ha_confirm_action_http}", "token_present": $( [[ -n "${confirm_token}" ]] && echo true || echo false ) },
  "ha_risk_policy_get": { "ok": $( [[ "${ha_policy_get_code}" -eq 0 && "${ha_policy_get_http}" -ge 200 && "${ha_policy_get_http}" -lt 300 ]] && echo true || echo false ), "exit_code": ${ha_policy_get_code}, "http_code": "${ha_policy_get_http}" },
  "ha_risk_policy_explain_vacuum": { "ok": $( [[ "${ha_policy_explain_vacuum_code}" -eq 0 && ( -z "${VACUUM}" || ("${ha_policy_explain_vacuum_http}" -ge 200 && "${ha_policy_explain_vacuum_http}" -lt 300) ) ]] && echo true || echo false ), "exit_code": ${ha_policy_explain_vacuum_code}, "http_code": "${ha_policy_explain_vacuum_http}", "candidate": "${VACUUM}", "skipped": $( [[ -z "${VACUUM}" ]] && echo true || echo false ) },
  "ha_risk_policy_explain_climate": { "ok": $( [[ "${ha_policy_explain_climate_code}" -eq 0 && ( -z "${CLIMATE}" || ("${ha_policy_explain_climate_http}" -ge 200 && "${ha_policy_explain_climate_http}" -lt 300) ) ]] && echo true || echo false ), "exit_code": ${ha_policy_explain_climate_code}, "http_code": "${ha_policy_explain_climate_http}", "candidate": "${CLIMATE}", "skipped": $( [[ -z "${CLIMATE}" ]] && echo true || echo false ) },
  "ha_risk_policy_explain_lock": { "ok": $( [[ "${ha_policy_explain_lock_code}" -eq 0 && ( -z "${LOCK}" || ("${ha_policy_explain_lock_http}" -ge 200 && "${ha_policy_explain_lock_http}" -lt 300) ) ]] && echo true || echo false ), "exit_code": ${ha_policy_explain_lock_code}, "http_code": "${ha_policy_explain_lock_http}", "candidate": "${LOCK}", "skipped": $( [[ -z "${LOCK}" ]] && echo true || echo false ) },
  "ha_uc_light": { "ok": $( [[ "${ha_light_code}" -eq 0 ]] && echo true || echo false ), "exit_code": ${ha_light_code}, "http_code": "${ha_light_http}", "candidate": "${LIGHT}", "skipped": $( [[ -z "${LIGHT}" ]] && echo true || echo false ) },
  "ha_uc_fan": { "ok": $( [[ "${ha_fan_code}" -eq 0 ]] && echo true || echo false ), "exit_code": ${ha_fan_code}, "http_code": "${ha_fan_http}", "candidate": "${FAN}", "skipped": $( [[ -z "${FAN}" ]] && echo true || echo false ) },
  "ha_uc_outlet": { "ok": $( [[ "${ha_outlet_code}" -eq 0 ]] && echo true || echo false ), "exit_code": ${ha_outlet_code}, "http_code": "${ha_outlet_http}", "candidate": "${OUTLET}", "skipped": $( [[ -z "${OUTLET}" ]] && echo true || echo false ) },
  "ha_uc_vacuum": { "ok": $( [[ "${ha_vacuum_code}" -eq 0 ]] && echo true || echo false ), "exit_code": ${ha_vacuum_code}, "http_code": "${ha_vacuum_http}", "candidate": "${VACUUM}", "skipped": $( [[ -z "${VACUUM}" ]] && echo true || echo false ) },
  "ha_uc_climate": { "ok": $( [[ "${ha_climate_code}" -eq 0 ]] && echo true || echo false ), "exit_code": ${ha_climate_code}, "http_code": "${ha_climate_http}", "candidate": "${CLIMATE}", "skipped": $( [[ -z "${CLIMATE}" ]] && echo true || echo false ) }
}
EOF_INNER
)

write_summary "${summary}"

if [[ "${candidate_select_code}" -ne 0 ]]; then
  write_blocker "candidate_select" "${candidate_select_code}" "" "Candidate selection failed. Check candidate_select.log."
  exit 1
fi
if [[ "${candidate_read_code}" -ne 0 ]]; then
  write_blocker "candidate_read" "${candidate_read_code}" "" "Candidate read failed. Check candidate_read.log."
  exit 1
fi
if [[ "${ha_ping_code}" -ne 0 || "${ha_ping_http}" -lt 200 || "${ha_ping_http}" -ge 300 ]]; then
  write_blocker "ha_ping" "${ha_ping_code}" "${ha_ping_http}" "ha_ping failed. Check ha_ping.log and ha_ping.json."
  exit 1
fi
if [[ "${ha_plan_action_code}" -ne 0 || "${ha_plan_action_http}" -lt 200 || "${ha_plan_action_http}" -ge 300 || "${plan_route_ok}" != "true" ]]; then
  write_blocker "ha_plan_action" "${ha_plan_action_code}" "${ha_plan_action_http}" "ha_plan_action inventory routing failed. Check ha_plan_action.json."
  exit 1
fi
if [[ "${ha_prepare_missing_code}" -ne 0 || "${ha_prepare_missing_http}" -lt 200 || "${ha_prepare_missing_http}" -ge 300 || "${missing_action_ok}" != "true" ]]; then
  write_blocker "ha_prepare_risky_action_missing" "${ha_prepare_missing_code}" "${ha_prepare_missing_http}" "ha_prepare_risky_action missing-action fallback failed. Check ha_prepare_risky_action_missing.json."
  exit 1
fi
if [[ "${ha_prepare_confirm_code}" -ne 0 || "${ha_prepare_confirm_http}" -lt 200 || "${ha_prepare_confirm_http}" -ge 300 ]]; then
  write_blocker "ha_prepare_risky_action" "${ha_prepare_confirm_code}" "${ha_prepare_confirm_http}" "ha_prepare_risky_action failed. Check ha_prepare_risky_action.json."
  exit 1
fi
if [[ -z "${confirm_token}" || "${ha_confirm_action_code}" -ne 0 || "${ha_confirm_action_http}" -lt 200 || "${ha_confirm_action_http}" -ge 300 ]]; then
  write_blocker "ha_confirm_action" "${ha_confirm_action_code}" "${ha_confirm_action_http}" "ha_confirm_action failed. Check ha_confirm_action.json."
  exit 1
fi
if [[ "${ha_policy_get_code}" -ne 0 || "${ha_policy_get_http}" -lt 200 || "${ha_policy_get_http}" -ge 300 ]]; then
  write_blocker "ha_risk_policy_get" "${ha_policy_get_code}" "${ha_policy_get_http}" "ha_risk_policy_get failed. Check ha_risk_policy_get.log and ha_risk_policy_get.json."
  exit 1
fi
if [[ -n "${VACUUM}" && ("${ha_policy_explain_vacuum_code}" -ne 0 || "${ha_policy_explain_vacuum_http}" -lt 200 || "${ha_policy_explain_vacuum_http}" -ge 300) ]]; then
  write_blocker "ha_risk_policy_explain_vacuum" "${ha_policy_explain_vacuum_code}" "${ha_policy_explain_vacuum_http}" "Risk policy explain vacuum failed. Check ha_risk_policy_explain_vacuum.log and ha_risk_policy_explain_vacuum.json."
  exit 1
fi
if [[ -n "${CLIMATE}" && ("${ha_policy_explain_climate_code}" -ne 0 || "${ha_policy_explain_climate_http}" -lt 200 || "${ha_policy_explain_climate_http}" -ge 300) ]]; then
  write_blocker "ha_risk_policy_explain_climate" "${ha_policy_explain_climate_code}" "${ha_policy_explain_climate_http}" "Risk policy explain climate failed. Check ha_risk_policy_explain_climate.log and ha_risk_policy_explain_climate.json."
  exit 1
fi
if [[ -n "${LOCK}" && ("${ha_policy_explain_lock_code}" -ne 0 || "${ha_policy_explain_lock_http}" -lt 200 || "${ha_policy_explain_lock_http}" -ge 300) ]]; then
  write_blocker "ha_risk_policy_explain_lock" "${ha_policy_explain_lock_code}" "${ha_policy_explain_lock_http}" "Risk policy explain lock failed. Check ha_risk_policy_explain_lock.log and ha_risk_policy_explain_lock.json."
  exit 1
fi
if [[ -n "${LIGHT}" && ("${ha_light_code}" -ne 0 || "${ha_light_http}" -lt 200 || "${ha_light_http}" -ge 300) ]]; then
  write_blocker "ha_uc_light" "${ha_light_code}" "${ha_light_http}" "Light safe_probe failed. Check ha_uc_light.log and ha_uc_light.json."
  exit 1
fi
if [[ -n "${FAN}" && ("${ha_fan_code}" -ne 0 || "${ha_fan_http}" -lt 200 || "${ha_fan_http}" -ge 300) ]]; then
  write_blocker "ha_uc_fan" "${ha_fan_code}" "${ha_fan_http}" "Fan safe_probe failed. Check ha_uc_fan.log and ha_uc_fan.json."
  exit 1
fi
if [[ -n "${OUTLET}" && ("${ha_outlet_code}" -ne 0 || "${ha_outlet_http}" -lt 200 || "${ha_outlet_http}" -ge 300) ]]; then
  write_blocker "ha_uc_outlet" "${ha_outlet_code}" "${ha_outlet_http}" "Outlet safe_probe failed. Check ha_uc_outlet.log and ha_uc_outlet.json."
  exit 1
fi
if [[ -n "${VACUUM}" && ("${ha_vacuum_code}" -ne 0 || "${ha_vacuum_http}" -lt 200 || "${ha_vacuum_http}" -ge 300) ]]; then
  write_blocker "ha_uc_vacuum" "${ha_vacuum_code}" "${ha_vacuum_http}" "Vacuum safe_probe failed. Check ha_uc_vacuum.log and ha_uc_vacuum.json."
  exit 1
fi
if [[ -n "${CLIMATE}" && ("${ha_climate_code}" -ne 0 || "${ha_climate_http}" -lt 200 || "${ha_climate_http}" -ge 300) ]]; then
  write_blocker "ha_uc_climate" "${ha_climate_code}" "${ha_climate_http}" "Climate safe_probe failed. Check ha_uc_climate.log and ha_uc_climate.json."
  exit 1
fi

exit 0
