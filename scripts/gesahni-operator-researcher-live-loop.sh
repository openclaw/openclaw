#!/usr/bin/env bash
set -euo pipefail

if ! command -v curl >/dev/null 2>&1; then
  echo "Missing curl" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "Missing jq" >&2
  exit 1
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

USER_ID="${GESAHNI_TEST_USER_ID:-tg:7975901790}"
BASE_URL="${GESAHNI_BASE_URL:-http://127.0.0.1:8000}"
if [[ "$BASE_URL" == *"host.docker.internal"* ]]; then
  BASE_URL="http://127.0.0.1:8000"
fi
READ_TOKEN="${GESAHNI_READ_BRIDGE_TOKEN:-}"
WRITE_TOKEN="${GESAHNI_WRITE_BRIDGE_TOKEN:-}"

if [[ -z "$READ_TOKEN" || -z "$WRITE_TOKEN" ]]; then
  echo "Missing GESAHNI_READ_BRIDGE_TOKEN or GESAHNI_WRITE_BRIDGE_TOKEN" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

post_write() {
  local path="$1"
  local body_file="$2"
  local out_file="$3"
  curl -sS -X POST "${BASE_URL}${path}" \
    -H "Authorization: Bearer ${WRITE_TOKEN}" \
    -H "X-User-Id: ${USER_ID}" \
    -H "Content-Type: application/json" \
    --data-binary "@${body_file}" >"${out_file}"
}

patch_write() {
  local path="$1"
  local body_file="$2"
  local out_file="$3"
  curl -sS -X PATCH "${BASE_URL}${path}" \
    -H "Authorization: Bearer ${WRITE_TOKEN}" \
    -H "X-User-Id: ${USER_ID}" \
    -H "Content-Type: application/json" \
    --data-binary "@${body_file}" >"${out_file}"
}

get_read() {
  local path="$1"
  local out_file="$2"
  curl -sS "${BASE_URL}${path}" \
    -H "Authorization: Bearer ${READ_TOKEN}" \
    -H "X-User-Id: ${USER_ID}" >"${out_file}"
}

# 0) health
curl -sS "${BASE_URL}/health" >"${TMP_DIR}/health.json"

# 1) create_project
cat >"${TMP_DIR}/create_project.json" <<'JSON'
{
  "title": "Smoke & Spark HVAC",
  "client_name": "Smoke & Spark HVAC",
  "project_type": "website",
  "goal": "local HVAC repair and installation"
}
JSON
post_write "/v1/bridge/projects" "${TMP_DIR}/create_project.json" "${TMP_DIR}/create_project.out.json"
project_id="$(jq -r '.snapshot.project.id // .project.id // empty' "${TMP_DIR}/create_project.out.json")"
if [[ -z "$project_id" || "$project_id" == "null" ]]; then
  echo "Failed to get project_id" >&2
  cat "${TMP_DIR}/create_project.out.json" >&2
  exit 1
fi

# 2) attach_project_context
cat >"${TMP_DIR}/attach_context.json" <<'JSON'
{
  "context_type": "website_brief",
  "source": "operator_chat",
  "content_json": {
    "business_summary": "local HVAC repair and installation",
    "site_scope": "multi-page",
    "current_website": "https://example.com",
    "references": ["https://example.org"],
    "preferred_tone": "clear and trustworthy",
    "required_pages": ["home", "services", "about", "contact"],
    "colors_branding": "primary #123456",
    "stack_preferences": "nextjs",
    "deploy_preference": "preview_only",
    "assets": ["logo.svg"]
  },
  "content_text": "Smoke & Spark HVAC website brief",
  "version": 1
}
JSON
post_write "/v1/bridge/projects/${project_id}/context" "${TMP_DIR}/attach_context.json" "${TMP_DIR}/attach_context.out.json"

# 3) update_intake_from_context
cat >"${TMP_DIR}/update_intake.json" <<'JSON'
{
  "payload": {}
}
JSON
post_write "/v1/bridge/projects/${project_id}/intake/update-from-context" "${TMP_DIR}/update_intake.json" "${TMP_DIR}/update_intake.out.json"

# 4) get_intake_snapshot
get_read "/v1/bridge/projects/${project_id}/intake/snapshot" "${TMP_DIR}/intake_snapshot.out.json"

# 5) initialize_website_workflow
cat >"${TMP_DIR}/init_workflow.json" <<'JSON'
{}
JSON
post_write "/v1/bridge/projects/${project_id}/website/workflow/initialize" "${TMP_DIR}/init_workflow.json" "${TMP_DIR}/init_workflow.out.json"

# 6) get_website_workflow_snapshot
get_read "/v1/bridge/projects/${project_id}/website/workflow/snapshot" "${TMP_DIR}/workflow_snapshot_before.out.json"

# 7) get_project_operator_summary
get_read "/v1/bridge/projects/${project_id}/operator/summary" "${TMP_DIR}/operator_summary_before.out.json"

research_task_id="$(jq -r '(.stages[]? | select(.stage=="research") | .task.id) // (.workflow.stages[]? | select(.stage=="research") | .task.id) // empty' "${TMP_DIR}/workflow_snapshot_before.out.json")"
if [[ -z "$research_task_id" || "$research_task_id" == "null" ]]; then
  echo "Failed to resolve research_task_id" >&2
  cat "${TMP_DIR}/workflow_snapshot_before.out.json" >&2
  exit 1
fi

# 8-11) researcher reads
get_read "/v1/bridge/projects/${project_id}" "${TMP_DIR}/research_get_project.out.json"
get_read "/v1/bridge/projects/${project_id}/intake/snapshot" "${TMP_DIR}/research_get_intake.out.json"
get_read "/v1/bridge/projects/${project_id}/website/workflow/snapshot" "${TMP_DIR}/research_get_workflow.out.json"
get_read "/v1/bridge/projects/${project_id}/operator/summary" "${TMP_DIR}/research_get_operator.out.json"

# 12) create research_summary artifact
jq -n \
  --arg project_id "$project_id" \
  --arg task_id "$research_task_id" \
  '{
    artifact_type:"research_summary",
    summary:"Smoke & Spark HVAC research summary based on provided intake context",
    task_id:$task_id,
    schema_version:"v1",
    preview_json:{
      schema_version:"v1",
      project_id:$project_id,
      task_id:$task_id,
      business_summary:"local HVAC repair and installation",
      site_scope:"multi-page",
      current_website:"https://example.com",
      references:["https://example.org"],
      preferred_tone:"clear and trustworthy",
      required_pages:["home","services","about","contact"],
      colors_branding:"primary #123456",
      stack_preferences:"nextjs",
      deploy_preference:"preview_only",
      assets:["logo.svg"],
      recommended_next_step:"builder_sitemap"
    }
  }' >"${TMP_DIR}/create_artifact.json"
post_write "/v1/bridge/projects/${project_id}/artifacts" "${TMP_DIR}/create_artifact.json" "${TMP_DIR}/create_artifact.out.json"
research_artifact_id="$(jq -r '.artifact.id // .artifact_id // empty' "${TMP_DIR}/create_artifact.out.json")"
if [[ -z "$research_artifact_id" || "$research_artifact_id" == "null" ]]; then
  echo "Failed to resolve research_artifact_id" >&2
  cat "${TMP_DIR}/create_artifact.out.json" >&2
  exit 1
fi

# 13) attach outputs
jq -n --arg aid "$research_artifact_id" '{output_artifact_ids:[$aid]}' >"${TMP_DIR}/attach_outputs.json"
post_write "/v1/bridge/projects/${project_id}/tasks/${research_task_id}/outputs" "${TMP_DIR}/attach_outputs.json" "${TMP_DIR}/attach_outputs.out.json"

# 14) update task status
cat >"${TMP_DIR}/update_status.json" <<'JSON'
{"status":"completed"}
JSON
patch_write "/v1/bridge/projects/${project_id}/tasks/${research_task_id}/status" "${TMP_DIR}/update_status.json" "${TMP_DIR}/update_status.out.json"
research_task_status="$(jq -r '.task.status // .status // "unknown"' "${TMP_DIR}/update_status.out.json")"

# 15) append project event (run-scoped when available, project-scoped fallback otherwise)
run_id="$(jq -r '.latest_run.id // .latest_run.run_id // .project.current_run_id // .workflow.current_run_id // empty' "${TMP_DIR}/operator_summary_before.out.json")"
event_failed_step=""
event_failed_error=""
event_path="/v1/bridge/projects/${project_id}/events"
if [[ -n "$run_id" && "$run_id" != "null" ]]; then
  event_path="/v1/bridge/projects/${project_id}/runs/${run_id}/events"
fi
jq -n \
  --arg project_id "$project_id" \
  --arg task_id "$research_task_id" \
  --arg artifact_id "$research_artifact_id" \
  '{
    event:"research_summary_created",
    source:"gesahni-researcher",
    level:"info",
    project_id:$project_id,
    task_id:$task_id,
    payload:{
      stage:"research",
      artifact_id:$artifact_id,
      recommended_next_step:"builder_sitemap"
    }
  }' >"${TMP_DIR}/append_event.json"
post_write "$event_path" "${TMP_DIR}/append_event.json" "${TMP_DIR}/append_event.out.json"
event_failed_error="$(jq -r '
  if (.ok == false) then
    (.error // .body // .statusText // "event append failed")
  elif ((.status // 0) >= 400) then
    (.error // .body // .statusText // "event append failed")
  elif ((.error_code // .message) != null) then
    ((.message // .error_code) | tostring)
  else
    ""
  end
' "${TMP_DIR}/append_event.out.json" 2>/dev/null || true)"
if [[ -n "$event_failed_error" && "$event_failed_error" != "null" ]]; then
  event_failed_step="researcher.append_project_event"
fi

# 16-17) re-read state
get_read "/v1/bridge/projects/${project_id}/website/workflow/snapshot" "${TMP_DIR}/workflow_snapshot_after.out.json"
get_read "/v1/bridge/projects/${project_id}/operator/summary" "${TMP_DIR}/operator_summary_after.out.json"

current_stage="$(jq -r '.current_stage // .workflow.current_stage // "unknown"' "${TMP_DIR}/workflow_snapshot_after.out.json")"
next_stage="$(jq -r '.next_stage // .workflow.next_stage // "unknown"' "${TMP_DIR}/workflow_snapshot_after.out.json")"

final_status="passed"
if [[ -n "$event_failed_step" ]]; then
  final_status="failed"
fi

jq -n \
  --arg project_id "$project_id" \
  --arg research_task_id "$research_task_id" \
  --arg research_artifact_id "$research_artifact_id" \
  --arg research_artifact_type "research_summary" \
  --arg research_task_status "$research_task_status" \
  --arg current_stage "$current_stage" \
  --arg next_stage "$next_stage" \
  --arg final_status "$final_status" \
  --arg failing_step "$event_failed_step" \
  --arg failing_error "$event_failed_error" \
  --slurpfile blockers "${TMP_DIR}/workflow_snapshot_after.out.json" \
  --slurpfile operator_summary "${TMP_DIR}/operator_summary_after.out.json" \
  --slurpfile workflow_after "${TMP_DIR}/workflow_snapshot_after.out.json" \
  --slurpfile event_result "${TMP_DIR}/append_event.out.json" \
  '{
    project_id:$project_id,
    research_task_id:$research_task_id,
    research_artifact_id:$research_artifact_id,
    research_artifact_type:$research_artifact_type,
    research_task_status:$research_task_status,
    current_stage:$current_stage,
    next_stage:$next_stage,
    blockers:($blockers[0].blockers // $blockers[0].workflow.blockers // []),
    operator_summary:$operator_summary[0],
    workflow_snapshot_after_research:$workflow_after[0],
    research_event_result:$event_result[0],
    final_status:$final_status,
    failing_step: (if $failing_step=="" then null else $failing_step end),
    failing_error: (if $failing_error=="" then null else $failing_error end)
  }'
