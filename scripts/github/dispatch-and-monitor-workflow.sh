#!/usr/bin/env bash
set -euo pipefail

workflow="${CHILD_WORKFLOW:-}"
workflow_ref="${CHILD_WORKFLOW_REF:-}"
poll_seconds="${CHILD_WORKFLOW_POLL_SECONDS:-30}"
fields_raw="${CHILD_WORKFLOW_FIELDS:-}"

if [[ -z "${workflow// }" ]]; then
  echo "CHILD_WORKFLOW is required." >&2
  exit 1
fi

if [[ -z "${workflow_ref// }" ]]; then
  echo "CHILD_WORKFLOW_REF is required." >&2
  exit 1
fi

if [[ -z "${GITHUB_REPOSITORY:-}" ]]; then
  echo "GITHUB_REPOSITORY is required." >&2
  exit 1
fi

if ! [[ "$poll_seconds" =~ ^[0-9]+$ ]] || [[ "$poll_seconds" -lt 1 ]]; then
  echo "CHILD_WORKFLOW_POLL_SECONDS must be a positive integer. Got: ${poll_seconds}" >&2
  exit 1
fi

dispatch_args=()
while IFS= read -r field; do
  [[ -n "${field// }" ]] || continue
  if [[ "$field" != *=* ]]; then
    echo "Invalid CHILD_WORKFLOW_FIELDS entry: ${field}" >&2
    exit 1
  fi
  dispatch_args+=("-f" "$field")
done <<< "$fields_raw"

before_json="$(gh run list --workflow "$workflow" --event workflow_dispatch --limit 100 --json databaseId --jq '[.[].databaseId]')"
dispatch_output="$(gh workflow run "$workflow" --ref "$workflow_ref" "${dispatch_args[@]}" 2>&1)"
printf '%s\n' "$dispatch_output"

run_id="$(
  printf '%s\n' "$dispatch_output" |
    sed -nE 's#.*actions/runs/([0-9]+).*#\1#p' |
    tail -n 1
)"

if [[ -z "$run_id" ]]; then
  for _ in $(seq 1 60); do
    run_id="$(
      BEFORE_IDS="$before_json" gh run list --workflow "$workflow" --event workflow_dispatch --limit 50 --json databaseId,createdAt \
        --jq 'map(select(.databaseId as $id | (env.BEFORE_IDS | fromjson | index($id) | not))) | sort_by(.createdAt) | reverse | .[0].databaseId // empty'
    )"
    if [[ -n "$run_id" ]]; then
      break
    fi
    sleep 5
  done
fi

if [[ -z "${run_id:-}" ]]; then
  echo "Could not find dispatched run for ${workflow}." >&2
  exit 1
fi

run_url="https://github.com/${GITHUB_REPOSITORY}/actions/runs/${run_id}"
echo "Dispatched ${workflow}: ${run_url}"
{
  echo "run_id=${run_id}"
  echo "url=${run_url}"
} >> "$GITHUB_OUTPUT"

{
  echo "### Child workflow"
  echo
  echo "- Workflow: \`${workflow}\`"
  echo "- Run: ${run_url}"
  echo "- Ref: \`${workflow_ref}\`"
} >> "$GITHUB_STEP_SUMMARY"

cleanup_child_run() {
  local exit_code=$?
  trap - EXIT INT TERM
  local child_status
  child_status="$(gh run view "$run_id" --json status --jq '.status' 2>/dev/null || true)"
  if [[ "$child_status" != "completed" ]]; then
    echo "Cancelling child ${workflow} run ${run_id} after parent exit (${exit_code})."
    gh run cancel "$run_id" || gh api -X POST "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/force-cancel" || true
  fi
  return "$exit_code"
}
trap cleanup_child_run EXIT INT TERM

while true; do
  status="$(gh run view "$run_id" --json status --jq '.status')"
  echo "${workflow} ${run_id}: ${status}"
  if [[ "$status" == "completed" ]]; then
    break
  fi
  sleep "$poll_seconds"
done
trap - EXIT INT TERM

conclusion="$(gh run view "$run_id" --json conclusion --jq '.conclusion')"
url="$(gh run view "$run_id" --json url --jq '.url')"
echo "${workflow} finished with ${conclusion}: ${url}"
{
  echo "url=${url}"
  echo "conclusion=${conclusion}"
} >> "$GITHUB_OUTPUT"

{
  echo "- Conclusion: \`${conclusion}\`"
} >> "$GITHUB_STEP_SUMMARY"

if [[ "$conclusion" != "success" ]]; then
  gh run view "$run_id" --json jobs --jq '.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | {name, status, conclusion, url}' || true
  exit 1
fi
