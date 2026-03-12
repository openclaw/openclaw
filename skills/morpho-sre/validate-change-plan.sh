#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CHECK_SCRIPT="${SCRIPT_DIR}/change-plan-check.sh"
ROLLOUT_SKIP="${VALIDATE_CHANGE_PLAN_SKIP_ROLLOUT:-0}"
ARGOCD_SYNC_STATUS_SCRIPT="${VALIDATE_CHANGE_PLAN_ARGOCD_SYNC_STATUS_SCRIPT:-${SCRIPT_DIR}/argocd-sync-status.sh}"

usage() {
  cat <<'EOF'
Usage:
  validate-change-plan.sh --plan <file> [--summary-file <file>] [--ownership-file <file>]

Validates repo-local commands from a normalized change plan.
Prints summary JSON to stdout.
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  }
}

for cmd in jq bash mktemp awk; do
  require_cmd "$cmd"
done

PLAN_FILE=""
OWNERSHIP_FILE=""
SUMMARY_FILE=""

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --plan)
      PLAN_FILE="${2:-}"
      shift 2
      ;;
    --summary-file)
      SUMMARY_FILE="${2:-}"
      shift 2
      ;;
    --ownership-file)
      OWNERSHIP_FILE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage
      exit 1
      ;;
  esac
done

[[ -n "$PLAN_FILE" ]] || {
  printf '--plan required\n' >&2
  exit 1
}

normalization_args=(--plan "$PLAN_FILE")
if [[ -n "$OWNERSHIP_FILE" ]]; then
  normalization_args+=(--ownership-file "$OWNERSHIP_FILE")
fi
NORMALIZED="$(bash "$CHECK_SCRIPT" "${normalization_args[@]}")"

order_repo_ids() {
  local normalized="$1"
  local -a ordered=()
  local -a pending=()
  local -a deps=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && pending+=("$line")
  done < <(jq -r '.repos[].repo_id' <<<"$normalized")
  while [[ "${#pending[@]}" -gt 0 ]]; do
    local progress=0
    local -a next_pending=()
    local repo_id unmet
    for repo_id in "${pending[@]}"; do
      deps=()
      while IFS= read -r dep; do
        [[ -n "$dep" ]] && deps+=("$dep")
      done < <(jq -r --arg repo "$repo_id" '.repos[] | select(.repo_id == $repo) | .depends_on_repos[]?' <<<"$normalized")
      unmet=0
      local dep
      for dep in "${deps[@]-}"; do
        if [[ ! " ${ordered[*]-} " =~ " ${dep} " ]]; then
          unmet=1
          break
        fi
      done
      if [[ "$unmet" -eq 0 ]]; then
        ordered+=("$repo_id")
        progress=1
      else
        next_pending+=("$repo_id")
      fi
    done
    [[ "$progress" -eq 1 ]] || {
      printf 'cyclic repo dependencies in change plan\n' >&2
      exit 1
    }
    if [[ "${#next_pending[@]}" -eq 0 ]]; then
      pending=()
    else
      pending=("${next_pending[@]}")
    fi
  done
  printf '%s\n' "${ordered[@]}"
}

impacted_apps_for_repo() {
  local repo_json="$1"
  local repo_id
  repo_id="$(jq -r '.repo_id // empty' <<<"$repo_json")"
  local explicit
  explicit="$(jq -c '.impacted_apps // []' <<<"$repo_json")"
  if [[ -n "$explicit" && "$explicit" != "[]" ]]; then
    printf '%s\n' "$explicit"
    return 0
  fi
  case "$repo_id" in
    openclaw-sre|morpho-infra-helm)
      printf '%s\n' '["openclaw-sre"]'
      ;;
    *)
      printf '%s\n' '[]'
      ;;
  esac
}

collect_rollout_snapshot() {
  if [[ "$ROLLOUT_SKIP" == "1" || ! -x "$ARGOCD_SYNC_STATUS_SCRIPT" ]]; then
    jq -cn '{status:"skipped", ci:"skipped", argocd:"skipped", errors:[], apps:[]}'
    return
  fi

  local stdout_file="${TMP_DIR}/argocd-sync-status.out"
  local stderr_file="${TMP_DIR}/argocd-sync-status.err"
  local header=""

  if ! "$ARGOCD_SYNC_STATUS_SCRIPT" >"$stdout_file" 2>"$stderr_file"; then
    jq -cn '{
      status: "error",
      ci: "best_effort",
      argocd: "error",
      errors: [{reason: "argocd_status_command_failed"}],
      apps: []
    }'
    return
  fi

  if ! IFS= read -r header <"$stdout_file"; then
    jq -cn '{status:"skipped", ci:"skipped", argocd:"skipped", errors:[], apps:[]}'
    return
  fi

  if [[ "$header" != $'app_name\tsync_status\thealth_status\tlast_sync_time\tlast_sync_result\tdrift_summary' ]]; then
    jq -cn '{
      status: "error",
      ci: "best_effort",
      argocd: "error",
      errors: [{reason: "argocd_status_invalid_output"}],
      apps: []
    }'
    return
  fi

  local apps_json
  apps_json="$(
    awk 'NR > 1 && NF > 0 { print }' "$stdout_file" \
      | jq -Rn '
          [inputs
           | split("\t")
           | select(length >= 6)
           | {
               app_name: .[0],
               sync_status: .[1],
               health_status: .[2],
               last_sync_time: .[3],
               last_sync_result: .[4],
               drift_summary: .[5]
             }]
        '
  )"

  jq -cn --argjson apps "$apps_json" '
    ($apps | map(select(
      .app_name == "argocd-api"
      and (.drift_summary | test("^(auth_http_|http_|missing_token|missing_dependency)"))
    ))) as $api_errors
    | {
        status: (if ($api_errors | length) == 0 then "ok" else "error" end),
        ci: "best_effort",
        argocd: (if ($api_errors | length) == 0 then "ok" else "error" end),
        errors: ($api_errors | map({
          reason: (if (.drift_summary | test("^(auth_http_|missing_token)")) then
            "argocd_auth_error"
          else
            "argocd_visibility_error"
          end),
          detail: .drift_summary
        })),
        apps: ($apps | map(select(.app_name != "argocd-api")))
      }
  '
}

evaluate_repo_rollout() {
  local impacted_apps_json="$1"
  local rollout_snapshot_json="$2"
  jq -cn --argjson impacted_apps "$impacted_apps_json" --argjson snapshot "$rollout_snapshot_json" '
    def app_matches($wanted):
      .app_name == $wanted or (.app_name | endswith("/" + $wanted));
    if $snapshot.status == "skipped" then
      {
        status: "skipped",
        ci: $snapshot.ci,
        argocd: $snapshot.argocd,
        impacted_apps: $impacted_apps,
        checks: [],
        errors: [],
        warnings: []
      }
    elif ($impacted_apps | length) == 0 then
      {
        status: "ok",
        ci: $snapshot.ci,
        argocd: $snapshot.argocd,
        impacted_apps: $impacted_apps,
        checks: [],
        errors: [],
        warnings: []
      }
    elif $snapshot.status != "ok" then
      {
        status: "error",
        ci: $snapshot.ci,
        argocd: $snapshot.argocd,
        impacted_apps: $impacted_apps,
        checks: [],
        errors: $snapshot.errors,
        warnings: []
      }
    else
      ($impacted_apps | map(
        . as $wanted
        | ($snapshot.apps | map(select(app_matches($wanted)))) as $matches
        | if ($matches | length) == 0 then
            {app_name: $wanted, status: "error", reason: "missing_app_visibility"}
          else
            ($matches[0]) as $app
            | if ($app.last_sync_result == "Failed" and ($app.sync_status != "Synced" or $app.health_status != "Healthy")) then
                $app + {status: "error", reason: "impacted_app_rollout_failed"}
              elif ($app.sync_status != "Synced" or $app.health_status != "Healthy") then
                $app + {status: "warning", reason: "impacted_app_unhealthy"}
              else
                $app + {status: "ok"}
              end
          end
      )) as $checks
      | {
          status: (
            if any($checks[]?; .status == "error") then
              "error"
            elif any($checks[]?; .status == "warning") then
              "warning"
            else
              "ok"
            end
          ),
          ci: $snapshot.ci,
          argocd: (
            if any($checks[]?; .status == "error") then
              "error"
            elif any($checks[]?; .status == "warning") then
              "warning"
            else
              "ok"
            end
          ),
          impacted_apps: $impacted_apps,
          checks: $checks,
          errors: ($checks | map(
            select(.status == "error")
            | if .reason == "missing_app_visibility" then
                {reason: .reason, app_name: .app_name}
              else
                {
                  reason: .reason,
                  app_name: .app_name,
                  sync_status: .sync_status,
                  health_status: .health_status,
                  last_sync_result: .last_sync_result,
                  drift_summary: .drift_summary
                }
              end
          )),
          warnings: ($checks | map(
            select(.status == "warning")
            | {
                reason: .reason,
                app_name: .app_name,
                sync_status: .sync_status,
                health_status: .health_status,
                last_sync_result: .last_sync_result,
                drift_summary: .drift_summary
              }
          ))
        }
    end
  '
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

declare -a ORDERED_REPOS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && ORDERED_REPOS+=("$line")
done < <(order_repo_ids "$NORMALIZED")

ROLLOUT_SNAPSHOT_JSON="$(collect_rollout_snapshot)"

declare -a RESULT_FILES=()
for repo_id in "${ORDERED_REPOS[@]-}"; do
  repo_json="$(jq -c --arg repo "$repo_id" '.repos[] | select(.repo_id == $repo)' <<<"$NORMALIZED")"
  repo_slug="$(jq -r '.repo_slug' <<<"$repo_json")"
  local_path="$(jq -r '.local_path' <<<"$repo_json")"
  declare -a validations=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && validations+=("$line")
  done < <(jq -r '.expected_validations[]' <<<"$repo_json")
  repo_result_file="${TMP_DIR}/${repo_id}.json"
  declare -a validation_result_lines=()
  overall_status="ok"

  idx=0
  for command in "${validations[@]-}"; do
    idx=$((idx + 1))
    output_file="${TMP_DIR}/${repo_id}.validation.${idx}.log"
    status="ok"
    if ! (cd "$local_path" && bash -lc "$command") >"$output_file" 2>&1; then
      status="error"
      overall_status="error"
    fi
    validation_result_lines+=("$(jq -cn --arg log "$output_file" --arg command "$command" --arg status "$status" '{log:$log, command:$command, status:$status}')")
  done

  impacted_apps="$(impacted_apps_for_repo "$repo_json")"
  rollout_json="$(evaluate_repo_rollout "$impacted_apps" "$ROLLOUT_SNAPSHOT_JSON")"
  rollout_status="$(jq -r '.status' <<<"$rollout_json")"
  if [[ "$rollout_status" == "error" ]]; then
    overall_status="error"
  fi

  validations_json='[]'
  if [[ "${#validation_result_lines[@]}" -gt 0 ]]; then
    validations_json="$(printf '%s\n' "${validation_result_lines[@]}" | jq -s '.')"
  fi

  jq -rn --arg repo_id "$repo_id" --arg repo_slug "$repo_slug" --arg local_path "$local_path" \
    --arg status "$overall_status" --argjson impacted_apps "$impacted_apps" --argjson rollout "$rollout_json" \
    --argjson validations "$validations_json" '
      {
        repo_id: $repo_id,
        repo_slug: $repo_slug,
        local_path: $local_path,
        status: $status,
        impacted_apps: $impacted_apps,
        rollout: $rollout,
        validations: $validations
      }' >"$repo_result_file"
  RESULT_FILES+=("$repo_result_file")
done

SUMMARY_JSON="$(
  jq -s \
    --arg plan_file "$PLAN_FILE" \
    '{
      version: "sre.change-plan-validation.v1",
      plan_file: $plan_file,
      repos: .,
      status: (if all(.[]; .status == "ok") then "ok" else "error" end)
    }' \
    "${RESULT_FILES[@]}"
)"

if [[ -n "$SUMMARY_FILE" ]]; then
  printf '%s\n' "$SUMMARY_JSON" >"$SUMMARY_FILE"
fi

printf '%s\n' "$SUMMARY_JSON"
