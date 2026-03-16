#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROUTING_CONFIG_DEFAULT="${SCRIPT_DIR}/bug-report-routing.json"
if [[ ! -f "$ROUTING_CONFIG_DEFAULT" && -f "${SCRIPT_DIR}/../bug-report-routing.json" ]]; then
  ROUTING_CONFIG_DEFAULT="${SCRIPT_DIR}/../bug-report-routing.json"
fi
LINEAR_API_DEFAULT="${SCRIPT_DIR}/linear-ticket-api.sh"
if [[ ! -x "$LINEAR_API_DEFAULT" && -x "${SCRIPT_DIR}/../linear-ticket-api.sh" ]]; then
  LINEAR_API_DEFAULT="${SCRIPT_DIR}/../linear-ticket-api.sh"
fi
die() {
  printf 'bug-report-triage: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || die "missing command: ${cmd}"
}

trim() {
  printf '%s' "${1:-}" | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//'
}

to_lower() {
  printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]'
}

validate_local_file_path() {
  local value="${1:-}"
  [[ -n "$value" ]] || die "missing file path"
  [[ "$value" != *$'\n'* ]] || die "invalid file path"
  case "$value" in
    ../*|*/../*|..)
      die "parent-relative file paths are not allowed: ${value}"
      ;;
  esac
  [[ -f "$value" ]] || die "file not found: ${value}"
  printf '%s\n' "$value"
}

validate_local_executable_path() {
  local value
  value="$(validate_local_file_path "${1:-}")"
  [[ -x "$value" ]] || die "file is not executable: ${value}"
  printf '%s\n' "$value"
}

sanitize_extracted_url() {
  local url="${1:-}"
  [[ -n "$url" ]] || {
    printf '\n'
    return 0
  }
  url="$(printf '%s' "$url" | tr -d '\r\n')"
  if [[ "${#url}" -gt 500 ]]; then
    url="${url:0:500}"
  fi
  case "$url" in
    http://*|https://*)
      printf '%s\n' "$url"
      ;;
    *)
      printf '\n'
      ;;
  esac
}

ROUTING_CONFIG="$(validate_local_file_path "${BUG_REPORT_ROUTING_CONFIG:-$ROUTING_CONFIG_DEFAULT}")"
LINEAR_API_RAW="${BUG_REPORT_LINEAR_API:-$LINEAR_API_DEFAULT}"

read_body_arg() {
  local mode="$1"
  local value="${2:-}"
  case "$mode" in
    --file)
      cat "$(validate_local_file_path "$value")"
      ;;
    --text)
      [[ -n "$value" ]] || die "missing text value"
      printf '%s' "$value"
      ;;
    --stdin)
      cat
      ;;
    *)
      die "unsupported body mode: ${mode}"
      ;;
  esac
}

extract_field() {
  local text="$1"
  local wanted
  wanted="$(to_lower "$2")"
  printf '%s\n' "$text" | awk -F: -v wanted="$wanted" '
    /^[[:space:]]*[^:]+:/ {
      key = $1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      if (tolower(key) == wanted) {
        sub(/^[^:]+:[[:space:]]*/, "", $0)
        print
        exit
      }
    }
  '
}

extract_first_url() {
  local text="$1"
  sanitize_extracted_url "$(
    printf '%s\n' "$text" \
    | grep -Eo 'https?://[^[:space:])>"]+' \
    | head -n 1 \
    || true
  )"
}

extract_thread_url() {
  local explicit_url="${1:-}"
  local text="$2"
  if [[ -n "$explicit_url" ]]; then
    sanitize_extracted_url "$explicit_url"
    return 0
  fi
  sanitize_extracted_url "$(
    printf '%s\n' "$text" \
    | grep -Eo 'https?://[^[:space:])>"]+' \
    | grep 'slack.com/archives/' \
    | head -n 1 \
    || true
  )"
}

extract_source_url() {
  local text="$1"
  local field_url first_url
  field_url="$(trim "$(extract_field "$text" "Source URL")")"
  if [[ -n "$field_url" ]]; then
    sanitize_extracted_url "$field_url"
    return 0
  fi
  first_url="$(extract_first_url "$text")"
  if [[ "$first_url" == *'slack.com/archives/'* ]]; then
    printf '\n'
    return 0
  fi
  printf '%s\n' "$first_url"
}

first_nonempty_line() {
  printf '%s\n' "$1" | awk 'NF { print; exit }'
}

truncate_text() {
  local text
  text="$(trim "${1:-}")"
  local limit="${2:-120}"
  if [[ ${#text} -le "$limit" ]]; then
    printf '%s\n' "$text"
    return 0
  fi
  printf '%s...\n' "${text:0:$((limit - 3))}"
}

extract_summary() {
  local text="$1"
  local title actual first_line summary
  title="$(trim "$(extract_field "$text" "Title")")"
  if [[ -n "$title" ]]; then
    truncate_text "$title" 120
    return 0
  fi
  actual="$(trim "$(extract_field "$text" "Actual result")")"
  if [[ -n "$actual" ]]; then
    truncate_text "$actual" 120
    return 0
  fi
  first_line="$(trim "$(first_nonempty_line "$text")")"
  summary="${first_line#Title: }"
  summary="${summary#title: }"
  truncate_text "$summary" 120
}

extract_actual_result() {
  local text="$1"
  local actual
  actual="$(trim "$(extract_field "$text" "Actual result")")"
  if [[ -n "$actual" ]]; then
    printf '%s\n' "$actual"
    return 0
  fi
  actual="$(trim "$(extract_field "$text" "Actual")")"
  printf '%s\n' "$actual"
}

extract_expected_result() {
  local text="$1"
  local expected
  expected="$(trim "$(extract_field "$text" "Expected result")")"
  if [[ -n "$expected" ]]; then
    printf '%s\n' "$expected"
    return 0
  fi
  expected="$(trim "$(extract_field "$text" "Expected")")"
  printf '%s\n' "$expected"
}

extract_environment() {
  local text="$1"
  local env
  env="$(trim "$(extract_field "$text" "Environment")")"
  printf '%s\n' "$env"
}

extract_priority_hint() {
  local text="$1"
  local priority severity
  priority="$(trim "$(extract_field "$text" "Priority")")"
  if [[ -n "$priority" ]]; then
    printf '%s\n' "$priority"
    return 0
  fi
  severity="$(trim "$(extract_field "$text" "Severity")")"
  printf '%s\n' "$severity"
}

priority_from_text() {
  local hint="$1"
  local report_lc="$2"
  local default_priority="${3:-3}"
  local hint_lc
  hint_lc="$(to_lower "$hint")"

  case "$hint_lc" in
    1|p1|sev1|critical|urgent)
      printf '1\n'
      return 0
      ;;
    2|p2|sev2|high)
      printf '2\n'
      return 0
      ;;
    3|p3|sev3|medium|normal)
      printf '3\n'
      return 0
      ;;
    4|p4|sev4|low)
      printf '4\n'
      return 0
      ;;
  esac

  if [[ "$report_lc" == *"critical"* || "$report_lc" == *"outage"* || "$report_lc" == *"funds stuck"* ]]; then
    printf '1\n'
    return 0
  fi
  if [[ "$report_lc" == *"p2"* || "$report_lc" == *"sev2"* || "$report_lc" == *"blocked"* || "$report_lc" == *"execution reverted"* ]]; then
    printf '2\n'
    return 0
  fi
  printf '%s\n' "$default_priority"
}

select_route_bundle() {
  local report_lc="$1"
  jq -c --arg report "$report_lc" '
    def hits($route):
      (($route.matchAny // [])
        | map(ascii_downcase)
        | map(. as $term | select($report | contains($term))));
    (.defaultRoute // "") as $default_route
    | (.routes // []) as $routes
    | ($routes | map({ id: .id, hits: hits(.) }) | map(select(.hits | length > 0))) as $matches
    | ($routes | map(select(.id == $default_route)) | .[0]) as $fallback
    | if $fallback == null then
        error("missing default route")
      elif ($matches | length) == 1 then
        {
          route: ($routes | map(select(.id == $matches[0].id)) | .[0]),
          matchedRoutes: [$matches[0].id],
          matchedTerms: ($matches[0].hits | unique),
          routingAmbiguous: false
        }
      elif ($matches | length) > 1 then
        {
          route: $fallback,
          matchedRoutes: ($matches | map(.id)),
          matchedTerms: ($matches | map(.hits[]) | unique),
          routingAmbiguous: true
        }
      else
        {
          route: $fallback,
          matchedRoutes: [],
          matchedTerms: [],
          routingAmbiguous: false
        }
      end
  ' "$ROUTING_CONFIG"
}

resolve_owner_json() {
  local owner_pool="${1:-}"
  jq -c --arg pool "$owner_pool" '
    (.ownerMissingMessage // "Owner rotation missing in bug-report config; manual assignment needed.") as $missing
    | (.ownerPools[$pool] // {}) as $pool_cfg
    | ($pool_cfg.rotation // []) as $rotation
    | ($pool_cfg.current // "") as $current
    | (($pool_cfg.currentIndex // 0) | tonumber? // 0) as $current_index
    | (
        if $current != "" then
          $current
        elif ($rotation | length) > 0 and $current_index < ($rotation | length) then
          ($rotation[$current_index] // "")
        else
          ""
        end
      ) as $assignee
    | {
        pool: (if $pool == "" then null else $pool end),
        assignee: (if $assignee == "" then null else $assignee end),
        display: (if $assignee == "" then $missing else $assignee end),
        missing: ($assignee == "")
      }
  ' "$ROUTING_CONFIG"
}

json_array_from_lines() {
  if [[ "$#" -eq 0 ]]; then
    printf '[]\n'
    return 0
  fi
  printf '%s\n' "$@" | awk 'NF > 0 && !seen[$0]++' | jq -Rsc 'split("\n") | map(select(length > 0))'
}

build_plan_json() {
  local report="$1"
  local explicit_thread_url="${2:-}"
  local report_lc route_bundle route_json owner_pool owner_json
  local summary environment source_url thread_url actual_result expected_result priority_hint
  local priority analysis_mode routing_ambiguous next_text matched_terms_json matched_routes_json
  local route_id route_team route_project route_priority route_analysis route_next labels_json
  local signal_lines signal matched_terms joined_terms
  local owner_missing

  summary="$(extract_summary "$report")"
  environment="$(extract_environment "$report")"
  source_url="$(extract_source_url "$report")"
  thread_url="$(extract_thread_url "$explicit_thread_url" "$report")"
  actual_result="$(extract_actual_result "$report")"
  expected_result="$(extract_expected_result "$report")"
  priority_hint="$(extract_priority_hint "$report")"
  report_lc="$(to_lower "$report")"

  route_bundle="$(select_route_bundle "$report_lc")"
  route_json="$(printf '%s\n' "$route_bundle" | jq -c '.route')"
  routing_ambiguous="$(printf '%s\n' "$route_bundle" | jq -r '.routingAmbiguous')"
  matched_terms_json="$(printf '%s\n' "$route_bundle" | jq -c '.matchedTerms')"
  matched_routes_json="$(printf '%s\n' "$route_bundle" | jq -c '.matchedRoutes')"

  route_id="$(printf '%s\n' "$route_json" | jq -r '.id')"
  route_team="$(printf '%s\n' "$route_json" | jq -r '.team // empty')"
  route_project="$(printf '%s\n' "$route_json" | jq -r '.project // empty')"
  route_priority="$(printf '%s\n' "$route_json" | jq -r '.priority // "3"')"
  route_analysis="$(printf '%s\n' "$route_json" | jq -r '.analysisMode // "light"')"
  route_next="$(printf '%s\n' "$route_json" | jq -r '.next // empty')"
  owner_pool="$(printf '%s\n' "$route_json" | jq -r '.ownerPool // empty')"
  owner_json="$(resolve_owner_json "$owner_pool")"
  owner_missing="$(printf '%s\n' "$owner_json" | jq -r '.missing')"

  priority="$(priority_from_text "$priority_hint" "$report_lc" "$route_priority")"
  analysis_mode="$route_analysis"
  if [[ "$priority" == "1" || "$priority" == "2" ]]; then
    analysis_mode="deep"
  fi

  next_text="$route_next"
  if [[ "$routing_ambiguous" == "true" ]]; then
    next_text="Routing ambiguous; keep manual-review label and tighten route before deep RCA."
  elif [[ "$owner_missing" == "true" ]]; then
    next_text="Manual assignment needed before PR work."
  fi

  labels_json="$(
    jq -nc \
      --argjson defaults "$(jq -c '.defaultLabels // []' "$ROUTING_CONFIG")" \
      --argjson routeLabels "$(printf '%s\n' "$route_json" | jq -c '.labels // []')" \
      --arg ambiguous "$routing_ambiguous" \
      --arg ownerMissing "$owner_missing" \
      '(
        $defaults
        + $routeLabels
        + (if $ambiguous == "true" or $ownerMissing == "true" then ["manual-review"] else [] end)
      ) | map(select(length > 0)) | unique'
  )"

  signal_lines=()
  if [[ -n "$environment" ]]; then
    signal_lines+=("environment:${environment}")
  fi
  if [[ -n "$source_url" ]]; then
    signal_lines+=("source:${source_url}")
  fi
  if [[ -n "$actual_result" ]]; then
    signal_lines+=("actual:$(truncate_text "$actual_result" 100)")
  fi
  joined_terms="$(printf '%s\n' "$matched_terms_json" | jq -r 'join(", ")')"
  if [[ -n "$joined_terms" ]]; then
    signal_lines+=("matched:${joined_terms}")
  fi
  signal_lines+=("priority:${priority}")

  jq -nc \
    --arg summary "$summary" \
    --arg environment "$environment" \
    --arg sourceUrl "$source_url" \
    --arg threadUrl "$thread_url" \
    --arg actualResult "$actual_result" \
    --arg expectedResult "$expected_result" \
    --arg priorityHint "$priority_hint" \
    --arg analysisMode "$analysis_mode" \
    --arg next "$next_text" \
    --arg priority "$priority" \
    --arg routingAmbiguous "$routing_ambiguous" \
    --arg team "$route_team" \
    --arg project "$route_project" \
    --arg routeId "$route_id" \
    --arg issueTitle "Bug: ${summary}" \
    --argjson route "$route_json" \
    --argjson owner "$owner_json" \
    --argjson labels "$labels_json" \
    --argjson matchedTerms "$matched_terms_json" \
    --argjson matchedRoutes "$matched_routes_json" \
    --argjson signals "$(json_array_from_lines "${signal_lines[@]}")" \
    '{
      summary: $summary,
      analysisMode: $analysisMode,
      routingAmbiguous: ($routingAmbiguous == "true"),
      route: (
        $route
        + {
            id: $routeId,
            team: $team,
            project: (if $project == "" then null else $project end),
            priority: $priority,
            labels: $labels,
            matchedTerms: $matchedTerms,
            matchedRoutes: $matchedRoutes
          }
      ),
      owner: $owner,
      summaryLine: $summary,
      signals: $signals,
      next: $next,
      linear: {
        title: $issueTitle
      },
      report: {
        environment: (if $environment == "" then null else $environment end),
        sourceUrl: (if $sourceUrl == "" then null else $sourceUrl end),
        threadUrl: (if $threadUrl == "" then null else $threadUrl end),
        actualResult: (if $actualResult == "" then null else $actualResult end),
        expectedResult: (if $expectedResult == "" then null else $expectedResult end),
        priorityHint: (if $priorityHint == "" then null else $priorityHint end)
      }
    }'
}

build_issue_body() {
  local report="$1"
  local plan_json="$2"
  local route_id team project priority analysis_mode owner_display source_url thread_url
  local actual_result expected_result

  route_id="$(printf '%s\n' "$plan_json" | jq -r '.route.id')"
  team="$(printf '%s\n' "$plan_json" | jq -r '.route.team // empty')"
  project="$(printf '%s\n' "$plan_json" | jq -r '.route.project // empty')"
  priority="$(printf '%s\n' "$plan_json" | jq -r '.route.priority')"
  analysis_mode="$(printf '%s\n' "$plan_json" | jq -r '.analysisMode')"
  owner_display="$(printf '%s\n' "$plan_json" | jq -r '.owner.display')"
  source_url="$(printf '%s\n' "$plan_json" | jq -r '.report.sourceUrl // empty')"
  thread_url="$(printf '%s\n' "$plan_json" | jq -r '.report.threadUrl // empty')"
  actual_result="$(printf '%s\n' "$plan_json" | jq -r '.report.actualResult // empty')"
  expected_result="$(printf '%s\n' "$plan_json" | jq -r '.report.expectedResult // empty')"

  cat <<EOF
## Intake
- Summary: $(printf '%s\n' "$plan_json" | jq -r '.summary')
- Route: ${route_id}
- Team: ${team}
- Project: ${project:-[none]}
- Priority: ${priority}
- Analysis mode: ${analysis_mode}
- Owner: ${owner_display}

## Signals
$(printf '%s\n' "$plan_json" | jq -r '.signals[] | "- " + .')

## Report Details
- Source URL: ${source_url:-[none]}
- Slack thread: ${thread_url:-[none]}
- Actual result: ${actual_result:-[none]}
- Expected result: ${expected_result:-[none]}

## Next
- $(printf '%s\n' "$plan_json" | jq -r '.next')

## Original Report
${report}
EOF
}

cmd_plan() {
  local body_mode="$1"
  local body_value="$2"
  local thread_url="${3:-}"
  local report
  report="$(read_body_arg "$body_mode" "$body_value")"
  build_plan_json "$report" "$thread_url"
}

cmd_create_issue() {
  local body_mode="$1"
  local body_value="$2"
  local explicit_thread_url="${3:-}"
  local report plan_json issue_body linear_title team project priority labels assignee attachment_url issue_json
  local labels_raw attachment_out attachment_status issue_identifier route_id thread_attached=true
  local -a issue_create_args
  local issue_create_status issue_create_err issue_create_stderr_file jq_err linear_api

  report="$(read_body_arg "$body_mode" "$body_value")"
  plan_json="$(build_plan_json "$report" "$explicit_thread_url")"

  linear_title="$(printf '%s\n' "$plan_json" | jq -r '.linear.title')"
  team="$(printf '%s\n' "$plan_json" | jq -r '.route.team // empty')"
  project="$(printf '%s\n' "$plan_json" | jq -r '.route.project // empty')"
  priority="$(printf '%s\n' "$plan_json" | jq -r '.route.priority')"
  labels_raw="$(printf '%s\n' "$plan_json" | jq -r '.route.labels | join("|")')"
  assignee="$(printf '%s\n' "$plan_json" | jq -r '.owner.assignee // empty')"
  attachment_url="$(printf '%s\n' "$plan_json" | jq -r '.report.threadUrl // empty')"
  issue_body="$(build_issue_body "$report" "$plan_json")"
  linear_api="$(validate_local_executable_path "$LINEAR_API_RAW")"

  [[ -n "$team" ]] || die "planner returned empty team"
  issue_create_args=(issue create --title "$linear_title" --text "$issue_body" --team "$team" --priority "$priority" --labels "$labels_raw")
  [[ -n "$project" ]] && issue_create_args+=(--project "$project")
  [[ -n "$assignee" ]] && issue_create_args+=(--assignee "$assignee")

  issue_create_stderr_file="$(mktemp "${TMPDIR:-/tmp}/bug-report-triage-issue-create.XXXXXX")"
  set +e
  issue_json="$(bash "$linear_api" "${issue_create_args[@]}" 2>"$issue_create_stderr_file")"
  issue_create_status=$?
  set -e
  issue_create_err="$(cat "$issue_create_stderr_file" 2>/dev/null || true)"
  rm -f "$issue_create_stderr_file"
  if [[ "$issue_create_status" -ne 0 ]]; then
    [[ -n "$issue_create_err" ]] && printf '%s\n' "$issue_create_err" >&2
    die "issue create failed"
  fi

  issue_create_stderr_file="$(mktemp "${TMPDIR:-/tmp}/bug-report-triage-issue-json.XXXXXX")"
  if ! printf '%s\n' "$issue_json" | jq -e . >/dev/null 2>"$issue_create_stderr_file"; then
    jq_err="$(cat "$issue_create_stderr_file" 2>/dev/null || true)"
    rm -f "$issue_create_stderr_file"
    [[ -n "$jq_err" ]] && printf '%s\n' "$jq_err" >&2
    printf '%s\n' "$issue_json" | sed -n '1,5p' >&2
    die "issue create returned invalid JSON"
  fi
  rm -f "$issue_create_stderr_file"
  issue_identifier="$(printf '%s\n' "$issue_json" | jq -r '.identifier // empty')"
  route_id="$(printf '%s\n' "$plan_json" | jq -r '.route.id // empty')"

  if [[ -n "$attachment_url" ]]; then
    set +e
    attachment_out="$(
      bash "$linear_api" issue add-attachment \
        "$issue_identifier" \
        "$attachment_url" \
        "Slack thread" \
        "$route_id" 2>&1
    )"
    attachment_status=$?
    set -e
    if [[ "$attachment_status" -ne 0 || "$attachment_out" != attached$'\t'* ]]; then
      printf 'bug-report-triage: warning: failed to attach Slack thread for %s (issue already created)\n' "${issue_identifier:-unknown}" >&2
      [[ -n "$attachment_out" ]] && printf '%s\n' "$attachment_out" >&2
      thread_attached=false
    fi
  fi

  jq -nc \
    --argjson plan "$plan_json" \
    --argjson issue "$issue_json" \
    --arg threadUrl "$attachment_url" \
    --argjson threadAttached "$thread_attached" \
    '{
      issue: {
        identifier: ($issue.identifier // null),
        url: ($issue.url // null),
        gitBranchName: ($issue.gitBranchName // null)
      },
      route: $plan.route,
      owner: $plan.owner,
      summary: $plan.summary,
      signals: $plan.signals,
      next: $plan.next,
      analysisMode: $plan.analysisMode,
      report: $plan.report,
      threadAttachment: (
        if $threadUrl == "" then
          null
        else
          { attached: $threadAttached, url: $threadUrl }
        end
      )
    }'
}

usage() {
  cat <<'EOF'
Usage:
  bug-report-triage.sh plan (--file <path> | --text <text> | --stdin) [--thread-url <url>]
  bug-report-triage.sh create-issue (--file <path> | --text <text> | --stdin) [--thread-url <url>]
EOF
}

main() {
  require_cmd jq

  [[ -f "$ROUTING_CONFIG" ]] || die "routing config not found: ${ROUTING_CONFIG}"
  [[ "$#" -ge 2 ]] || {
    usage
    exit 1
  }

  local cmd="$1"
  shift

  local body_mode=""
  local body_value=""
  local thread_url=""

  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --file|--text)
        body_mode="$1"
        body_value="${2:-}"
        shift 2
        ;;
      --stdin)
        body_mode="$1"
        body_value=""
        shift
        ;;
      --thread-url)
        thread_url="${2:-}"
        shift 2
        ;;
      -h|--help|help)
        usage
        return 0
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
  done

  [[ -n "$body_mode" ]] || die "missing one of --file|--text|--stdin"

  case "$cmd" in
    plan)
      cmd_plan "$body_mode" "$body_value" "$thread_url"
      ;;
    create-issue)
      cmd_create_issue "$body_mode" "$body_value" "$thread_url"
      ;;
    *)
      die "unknown command: ${cmd}"
      ;;
  esac
}

main "$@"
