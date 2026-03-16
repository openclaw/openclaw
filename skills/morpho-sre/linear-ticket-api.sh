#!/usr/bin/env bash
set -euo pipefail

LINEAR_API_URL="${LINEAR_API_URL:-https://api.linear.app/graphql}"
LINEAR_CURL_BIN="${LINEAR_CURL_BIN:-curl}"

die() {
  printf 'linear-ticket-api: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || die "missing command: ${cmd}"
}

linear_token() {
  local token="${LINEAR_API_KEY:-${LINEAR_TOKEN:-}}"
  [[ -n "$token" ]] || die "missing LINEAR_API_KEY/LINEAR_TOKEN"
  printf '%s\n' "$token"
}

linear_graphql() {
  local query="$1"
  local vars_json="${2:-}"
  if [[ -z "$vars_json" ]]; then
    vars_json='{}'
  fi

  local token payload response error_msg
  if ! token="$(linear_token)"; then
    return 1
  fi
  if ! payload="$(
    jq -nc \
      --arg query "$query" \
      --argjson variables "$vars_json" \
      '{ query: $query, variables: $variables }'
  )"; then
    die "failed to build graphql payload"
  fi

  if ! response="$(
    "$LINEAR_CURL_BIN" -fsS "$LINEAR_API_URL" \
      -H "Authorization: ${token}" \
      -H "Content-Type: application/json" \
      --data "$payload"
  )"; then
    die "request failed"
  fi

  printf '%s\n' "$response" | jq -e . >/dev/null 2>&1 || die "invalid JSON response"
  if printf '%s\n' "$response" | jq -e '.errors and (.errors | length > 0)' >/dev/null 2>&1; then
    error_msg="$(
      printf '%s\n' "$response" \
        | jq -r '(.errors[0].message // "unknown GraphQL error")'
    )"
    die "$error_msg"
  fi

  printf '%s\n' "$response"
}

lookup_entity_id() {
  local entity_type="$1"
  local name="$2"
  local query=""
  local path=""
  local vars_json response entity_id

  case "$entity_type" in
    team)
      query='query($name:String!){ teams(filter:{name:{eq:$name}}){ nodes { id name } } }'
      path='.data.teams.nodes[0].id // empty'
      ;;
    project)
      query='query($name:String!){ projects(filter:{name:{eq:$name}}){ nodes { id name } } }'
      path='.data.projects.nodes[0].id // empty'
      ;;
    user)
      query='query($name:String!){ users(filter:{name:{eq:$name}}){ nodes { id name email } } }'
      path='.data.users.nodes[0].id // empty'
      ;;
    label)
      query='query($name:String!){ issueLabels(filter:{name:{eq:$name}}){ nodes { id name } } }'
      path='.data.issueLabels.nodes[0].id // empty'
      ;;
    *)
      die "unsupported lookup entity: ${entity_type}"
      ;;
  esac

  vars_json="$(jq -nc --arg name "$name" '{ name: $name }')"
  response="$(linear_graphql "$query" "$vars_json")"
  entity_id="$(printf '%s\n' "$response" | jq -r "$path")"
  [[ -n "$entity_id" ]] || die "not found: ${entity_type}=${name}"
  printf '%s\n' "$entity_id"
}

lookup_label_id_optional() {
  local name="$1"
  local vars_json response label_id
  vars_json="$(jq -nc --arg name "$name" '{ name: $name }')"
  response="$(linear_graphql 'query($name:String!){ issueLabels(filter:{name:{eq:$name}}){ nodes { id name } } }' "$vars_json")"
  label_id="$(printf '%s\n' "$response" | jq -r '.data.issueLabels.nodes[0].id // empty')"
  [[ -n "$label_id" ]] || return 1
  printf '%s\n' "$label_id"
}

is_uuid_like() {
  [[ "${1:-}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]
}

resolve_entity_id() {
  local entity_type="$1"
  local raw="${2:-}"
  local viewer_id
  if [[ -z "$raw" ]]; then
    return 1
  fi
  case "$entity_type" in
    user|team|project|label) ;;
    *)
      die "unsupported lookup entity: ${entity_type}"
      ;;
  esac
  if is_uuid_like "$raw"; then
    printf '%s\n' "$raw"
    return 0
  fi
  case "$entity_type" in
    user)
      if [[ "$raw" == "me" ]]; then
        viewer_id="$(
          linear_graphql 'query { viewer { id } }' \
            | jq -r '.data.viewer.id // empty'
        )"
        [[ -n "$viewer_id" ]] || die "viewer query returned empty id - check Linear API authentication"
        is_uuid_like "$viewer_id" || die "viewer query returned invalid id - check Linear API authentication"
        printf '%s\n' "$viewer_id"
        return 0
      fi
      ;;
  esac
  lookup_entity_id "$entity_type" "$raw"
}

resolve_team_name() {
  local team_ref="${1:-}"
  local vars_json response team_name
  [[ -n "$team_ref" ]] || die "missing team reference"
  if ! is_uuid_like "$team_ref"; then
    printf '%s\n' "$team_ref"
    return 0
  fi
  vars_json="$(jq -nc --arg id "$team_ref" '{ id: $id }')"
  response="$(linear_graphql 'query($id:String!){ team(id:$id){ id name } }' "$vars_json")"
  team_name="$(printf '%s\n' "$response" | jq -r '.data.team.name // empty')"
  [[ -n "$team_name" ]] || die "team not found: ${team_ref}"
  printf '%s\n' "$team_name"
}

lookup_workflow_state_id() {
  local team_ref="${1:-}"
  local state_ref="${2:-}"
  local team_name vars_json response state_id

  [[ -n "$team_ref" ]] || die "missing team reference for workflow state lookup"
  [[ -n "$state_ref" ]] || die "missing workflow state reference"
  if is_uuid_like "$state_ref"; then
    printf '%s\n' "$state_ref"
    return 0
  fi

  team_name="$(resolve_team_name "$team_ref")"
  vars_json="$(
    jq -nc \
      --arg teamName "$team_name" \
      --arg stateName "$state_ref" \
      '{ teamName: $teamName, stateName: $stateName }'
  )"
  response="$(linear_graphql 'query($teamName:String!,$stateName:String!){ workflowStates(filter:{team:{name:{eq:$teamName}},name:{eq:$stateName}}){ nodes { id name } } }' "$vars_json")"
  state_id="$(printf '%s\n' "$response" | jq -r '.data.workflowStates.nodes[0].id // empty')"
  [[ -n "$state_id" ]] || die "workflow state not found: ${state_ref} (team=${team_name})"
  printf '%s\n' "$state_id"
}

parse_label_refs_json() {
  local raw="${1:-}"
  local label_ref label_id
  if [[ -z "$raw" ]]; then
    printf '[]\n'
    return 0
  fi

  while IFS= read -r label_ref; do
    [[ -n "$label_ref" ]] || continue
    if is_uuid_like "$label_ref"; then
      printf '%s\n' "$label_ref"
      continue
    fi
    if ! label_id="$(lookup_label_id_optional "$label_ref")"; then
      label_id="$(create_label "$label_ref")"
    fi
    printf '%s\n' "$label_id"
  done < <(
    printf '%s\n' "$raw" \
      | tr ',|' '\n' \
      | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' \
      | awk 'NF > 0 && !seen[$0]++'
  ) \
    | jq -Rsc 'split("\n") | map(select(length > 0))'
}

normalize_priority_value() {
  local raw="${1:-}"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
  case "$raw" in
    ""|none|unset|n/a)
      printf '0\n'
      ;;
    0|1|2|3|4)
      printf '%s\n' "$raw"
      ;;
    urgent|critical|sev0|sev1|p0|p1)
      printf '1\n'
      ;;
    high|major|sev2|p2)
      printf '2\n'
      ;;
    medium|normal|default|sev3|p3)
      printf '3\n'
      ;;
    low|minor|cosmetic|sev4|p4)
      printf '4\n'
      ;;
    *)
      die "unsupported priority: ${1:-}"
      ;;
  esac
}

create_label() {
  local name="$1"
  local color="${2:-#0E8A16}"
  local vars_json response success label_id
  vars_json="$(
    jq -nc \
      --arg name "$name" \
      --arg color "$color" \
      '{ name: $name, color: $color }'
  )"
  response="$(linear_graphql 'mutation($name:String!,$color:String!){ issueLabelCreate(input:{name:$name,color:$color}){ success issueLabel { id name } } }' "$vars_json")"
  success="$(printf '%s\n' "$response" | jq -r '.data.issueLabelCreate.success // empty')"
  [[ "$success" == "true" ]] || die "issueLabelCreate returned success=false"
  label_id="$(printf '%s\n' "$response" | jq -r '.data.issueLabelCreate.issueLabel.id // empty')"
  [[ -n "$label_id" ]] || die "issueLabelCreate missing label id"
  printf '%s\n' "$label_id"
}

issue_json_by_ref() {
  local issue_ref="$1"
  local vars_json response
  vars_json="$(jq -nc --arg id "$issue_ref" '{ id: $id }')"
  response="$(linear_graphql 'query($id:String!){ issue(id:$id){ id identifier title description url gitBranchName state { id name } labels { nodes { id name } } } }' "$vars_json")"
  printf '%s\n' "$response"
}

issue_id_by_ref() {
  local issue_ref="$1"
  local response issue_id
  response="$(issue_json_by_ref "$issue_ref")"
  issue_id="$(printf '%s\n' "$response" | jq -r '.data.issue.id // empty')"
  [[ -n "$issue_id" ]] || die "issue not found: ${issue_ref}"
  printf '%s\n' "$issue_id"
}

read_body_arg() {
  local mode="$1"
  local value="${2:-}"
  case "$mode" in
    --file)
      [[ -n "$value" ]] || die "missing file path"
      [[ -f "$value" ]] || die "file not found: ${value}"
      cat "$value"
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

cmd_issue_get() {
  local issue_ref="$1"
  issue_json_by_ref "$issue_ref" \
    | jq -c '.data.issue // {}'
}

cmd_issue_get_branch() {
  local issue_ref="$1"
  local response issue_id git_branch_name
  response="$(issue_json_by_ref "$issue_ref")"
  issue_id="$(printf '%s\n' "$response" | jq -r '.data.issue.id // empty')"
  [[ -n "$issue_id" ]] || die "issue not found: ${issue_ref}"
  git_branch_name="$(printf '%s\n' "$response" | jq -r '.data.issue.gitBranchName // empty')"
  [[ -n "$git_branch_name" ]] || die "issue missing gitBranchName: ${issue_ref}"
  printf '%s\n' "$git_branch_name"
}

cmd_issue_create() {
  local title="$1"
  local body_mode="$2"
  local body_value="$3"
  local team_ref="$4"
  local project_ref="${5:-}"
  local assignee_ref="${6:-}"
  local state_ref="${7:-}"
  local priority_ref="${8:-}"
  local labels_raw="${9:-}"
  local description team_id project_id assignee_id state_id priority_value label_ids_json
  local vars_json response success identifier url git_branch_name

  [[ -n "$title" ]] || die "missing issue title"
  [[ -n "$team_ref" ]] || die "missing team reference"

  description="$(read_body_arg "$body_mode" "$body_value")"
  team_id="$(resolve_entity_id team "$team_ref")"

  project_id=""
  if [[ -n "$project_ref" ]]; then
    project_id="$(resolve_entity_id project "$project_ref")"
  fi

  assignee_id=""
  if [[ -n "$assignee_ref" ]]; then
    assignee_id="$(resolve_entity_id user "$assignee_ref")"
  fi

  state_id=""
  if [[ -n "$state_ref" ]]; then
    state_id="$(lookup_workflow_state_id "$team_ref" "$state_ref")"
  fi

  priority_value=""
  if [[ -n "$priority_ref" ]]; then
    priority_value="$(normalize_priority_value "$priority_ref")"
  fi

  label_ids_json="$(parse_label_refs_json "$labels_raw")"

  vars_json="$(
    jq -nc \
      --arg title "$title" \
      --arg description "$description" \
      --arg teamId "$team_id" \
      --arg projectId "$project_id" \
      --arg assigneeId "$assignee_id" \
      --arg stateId "$state_id" \
      --arg priority "$priority_value" \
      --argjson labelIds "$label_ids_json" \
      '{
        input: ({
          title: $title,
          description: $description,
          teamId: $teamId
        }
        + (if $projectId != "" then { projectId: $projectId } else {} end)
        + (if $assigneeId != "" then { assigneeId: $assigneeId } else {} end)
        + (if $stateId != "" then { stateId: $stateId } else {} end)
        + (if $priority != "" and $priority != "0" then { priority: ($priority | tonumber) } else {} end)
        + (if ($labelIds | length) > 0 then { labelIds: $labelIds } else {} end))
      }'
  )"
  response="$(linear_graphql 'mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue { id identifier title url gitBranchName } } }' "$vars_json")"
  success="$(printf '%s\n' "$response" | jq -r '.data.issueCreate.success // empty')"
  [[ "$success" == "true" ]] || die "issueCreate returned success=false"
  identifier="$(printf '%s\n' "$response" | jq -r '.data.issueCreate.issue.identifier // empty')"
  [[ -n "$identifier" ]] || die "issueCreate missing identifier"
  url="$(printf '%s\n' "$response" | jq -r '.data.issueCreate.issue.url // empty')"
  git_branch_name="$(printf '%s\n' "$response" | jq -r '.data.issueCreate.issue.gitBranchName // empty')"

  jq -nc \
    --arg identifier "$identifier" \
    --arg url "$url" \
    --arg gitBranchName "$git_branch_name" \
    '{
      identifier: $identifier,
      url: (if $url == "" then null else $url end),
      gitBranchName: (if $gitBranchName == "" then null else $gitBranchName end)
    }'
}

cmd_issue_update_description() {
  local issue_ref="$1"
  local body_mode="$2"
  local body_value="${3:-}"
  local issue_id body vars_json response success identifier

  issue_id="$(issue_id_by_ref "$issue_ref")"
  body="$(read_body_arg "$body_mode" "$body_value")"
  vars_json="$(
    jq -nc \
      --arg id "$issue_id" \
      --arg description "$body" \
      '{ id: $id, description: $description }'
  )"
  response="$(linear_graphql 'mutation($id:String!,$description:String!){ issueUpdate(id:$id,input:{description:$description}){ success issue { identifier } } }' "$vars_json")"
  success="$(printf '%s\n' "$response" | jq -r '.data.issueUpdate.success // empty')"
  [[ "$success" == "true" ]] || die "issueUpdate returned success=false"
  identifier="$(printf '%s\n' "$response" | jq -r '.data.issueUpdate.issue.identifier // empty')"
  printf 'updated\t%s\n' "${identifier:-$issue_ref}"
}

cmd_issue_add_comment() {
  local issue_ref="$1"
  local body_mode="$2"
  local body_value="${3:-}"
  local issue_id body vars_json response success comment_id

  issue_id="$(issue_id_by_ref "$issue_ref")"
  body="$(read_body_arg "$body_mode" "$body_value")"
  vars_json="$(
    jq -nc \
      --arg issueId "$issue_id" \
      --arg body "$body" \
      '{ issueId: $issueId, body: $body }'
  )"
  response="$(linear_graphql 'mutation($issueId:String!,$body:String!){ commentCreate(input:{issueId:$issueId,body:$body}){ success comment { id } } }' "$vars_json")"
  success="$(printf '%s\n' "$response" | jq -r '.data.commentCreate.success // empty')"
  [[ "$success" == "true" ]] || die "commentCreate returned success=false"
  comment_id="$(printf '%s\n' "$response" | jq -r '.data.commentCreate.comment.id // empty')"
  printf 'commented\t%s\t%s\n' "$issue_ref" "${comment_id:-unknown}"
}

cmd_issue_ensure_label() {
  local issue_ref="$1"
  local label_name="$2"
  local issue_json issue_id existing_names_json existing_label_ids_json label_id merged_label_ids_json
  local vars_json response success

  issue_json="$(issue_json_by_ref "$issue_ref")"
  issue_id="$(printf '%s\n' "$issue_json" | jq -r '.data.issue.id // empty')"
  [[ -n "$issue_id" ]] || die "issue not found: ${issue_ref}"

  existing_names_json="$(printf '%s\n' "$issue_json" | jq -c '[.data.issue.labels.nodes[]?.name]')"
  if printf '%s\n' "$existing_names_json" | jq -e --arg name "$label_name" 'index($name) != null' >/dev/null 2>&1; then
    printf 'label_present\t%s\t%s\n' "$issue_ref" "$label_name"
    return 0
  fi

  if ! label_id="$(lookup_label_id_optional "$label_name")"; then
    label_id="$(create_label "$label_name")"
  fi

  existing_label_ids_json="$(printf '%s\n' "$issue_json" | jq -c '[.data.issue.labels.nodes[]?.id]')"
  merged_label_ids_json="$(
    printf '%s\n' "$existing_label_ids_json" \
      | jq -c --arg label_id "$label_id" 'if index($label_id) != null then . else . + [$label_id] end'
  )"
  vars_json="$(
    jq -nc \
      --arg id "$issue_id" \
      --argjson labelIds "$merged_label_ids_json" \
      '{ id: $id, labelIds: $labelIds }'
  )"
  response="$(linear_graphql 'mutation($id:String!,$labelIds:[String!]!){ issueUpdate(id:$id,input:{labelIds:$labelIds}){ success issue { identifier labels { nodes { id name } } } } }' "$vars_json")"
  success="$(printf '%s\n' "$response" | jq -r '.data.issueUpdate.success // empty')"
  [[ "$success" == "true" ]] || die "issueUpdate(labelIds) returned success=false"
  printf 'labeled\t%s\t%s\n' "$issue_ref" "$label_name"
}

cmd_issue_add_attachment() {
  local issue_ref="$1"
  local attachment_url="$2"
  local attachment_title="${3:-}"
  local attachment_subtitle="${4:-}"
  local issue_id vars_json response success attachment_id

  [[ -n "$attachment_url" ]] || die "missing attachment url"
  issue_id="$(issue_id_by_ref "$issue_ref")"
  vars_json="$(
    jq -nc \
      --arg issueId "$issue_id" \
      --arg url "$attachment_url" \
      --arg title "$attachment_title" \
      --arg subtitle "$attachment_subtitle" \
      '{ issueId: $issueId, url: $url, title: $title, subtitle: $subtitle }'
  )"
  response="$(linear_graphql 'mutation($issueId:String!,$url:String!,$title:String!,$subtitle:String!){ attachmentCreate(input:{issueId:$issueId,url:$url,title:$title,subtitle:$subtitle}){ success attachment { id url } } }' "$vars_json")"
  success="$(printf '%s\n' "$response" | jq -r '.data.attachmentCreate.success // empty')"
  [[ "$success" == "true" ]] || die "attachmentCreate returned success=false"
  attachment_id="$(printf '%s\n' "$response" | jq -r '.data.attachmentCreate.attachment.id // empty')"
  printf 'attached\t%s\t%s\n' "$issue_ref" "${attachment_id:-unknown}"
}

cmd_probe_write() {
  local issue_ref="$1"
  local response issue_id issue_title vars_json mutation_response success identifier

  response="$(issue_json_by_ref "$issue_ref")"
  issue_id="$(printf '%s\n' "$response" | jq -r '.data.issue.id // empty')"
  issue_title="$(printf '%s\n' "$response" | jq -r '.data.issue.title // empty')"
  [[ -n "$issue_id" && -n "$issue_title" ]] || die "issue not found: ${issue_ref}"

  vars_json="$(
    jq -nc \
      --arg id "$issue_id" \
      --arg title "$issue_title" \
      '{ id: $id, title: $title }'
  )"
  mutation_response="$(linear_graphql 'mutation($id:String!,$title:String!){ issueUpdate(id:$id,input:{title:$title}){ success issue { identifier } } }' "$vars_json")"
  success="$(printf '%s\n' "$mutation_response" | jq -r '.data.issueUpdate.success // empty')"
  [[ "$success" == "true" ]] || die "write probe failed"
  identifier="$(printf '%s\n' "$mutation_response" | jq -r '.data.issueUpdate.issue.identifier // empty')"
  printf 'probe_ok\t%s\n' "${identifier:-$issue_ref}"
}

cmd_probe_auth() {
  local response viewer_id viewer_name viewer_email

  response="$(linear_graphql 'query { viewer { id name email } }')"
  viewer_id="$(printf '%s\n' "$response" | jq -r '.data.viewer.id // empty')"
  [[ -n "$viewer_id" ]] || die "viewer probe returned no viewer id"
  viewer_name="$(printf '%s\n' "$response" | jq -r '.data.viewer.name // empty')"
  viewer_email="$(printf '%s\n' "$response" | jq -r '.data.viewer.email // empty')"

  jq -nc \
    --arg viewerId "$viewer_id" \
    --arg viewerName "$viewer_name" \
    --arg viewerEmail "$viewer_email" \
    '{
      ok: true,
      viewerId: $viewerId,
      viewerName: (if $viewerName == "" then null else $viewerName end),
      viewerEmail: (if $viewerEmail == "" then null else $viewerEmail end)
    }'
}

usage() {
  cat <<'EOF'
Usage:
  linear-ticket-api.sh lookup <team|project|user|label> <name>
  linear-ticket-api.sh issue get <issue-ref>
  linear-ticket-api.sh issue get-branch <issue-ref>
  linear-ticket-api.sh issue create --title <title> (--file <path> | --text <text> | --stdin) --team <team> [--project <project>] [--assignee <user|me>] [--state <state>] [--priority <0-4|urgent|high|normal|low>] [--labels <label1|label2>]
  linear-ticket-api.sh issue update-description <issue-ref> (--file <path> | --text <text> | --stdin)
  linear-ticket-api.sh issue add-comment <issue-ref> (--file <path> | --text <text> | --stdin)
  linear-ticket-api.sh issue add-attachment <issue-ref> <url> [title] [subtitle]
  linear-ticket-api.sh issue ensure-label <issue-ref> <label-name>
  linear-ticket-api.sh probe-auth
  linear-ticket-api.sh probe-write <issue-ref>

Compatibility:
  linear-ticket-api.sh <team|project|user|label> <name>
EOF
}

main() {
  require_cmd jq
  require_cmd "$LINEAR_CURL_BIN"

  [[ "$#" -ge 1 ]] || {
    usage
    exit 1
  }

  # Compatibility mode for lib-linear-preflight.sh ($LINEAR_LOOKUP_CMD entity name).
  if [[ "$#" -eq 2 ]]; then
    case "$1" in
      team|project|user|label)
        lookup_entity_id "$1" "$2"
        exit 0
        ;;
    esac
  fi

  case "$1" in
    lookup)
      [[ "$#" -eq 3 ]] || die "usage: lookup <entity> <name>"
      lookup_entity_id "$2" "$3"
      ;;
    issue)
      [[ "$#" -ge 3 ]] || die "usage: issue <get|update-description|add-comment|ensure-label> <issue-ref> ..."
      case "$2" in
        get)
          [[ "$#" -eq 3 ]] || die "usage: issue get <issue-ref>"
          cmd_issue_get "$3"
          ;;
        get-branch)
          [[ "$#" -eq 3 ]] || die "usage: issue get-branch <issue-ref>"
          cmd_issue_get_branch "$3"
          ;;
        create)
          shift 2
          local title=""
          local body_mode=""
          local body_value=""
          local team_ref=""
          local project_ref=""
          local assignee_ref=""
          local state_ref=""
          local priority_ref=""
          local labels_raw=""
          while [[ "$#" -gt 0 ]]; do
            case "$1" in
              --title)
                title="${2:-}"
                shift 2
                ;;
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
              --team)
                team_ref="${2:-}"
                shift 2
                ;;
              --project)
                project_ref="${2:-}"
                shift 2
                ;;
              --assignee)
                assignee_ref="${2:-}"
                shift 2
                ;;
              --state)
                state_ref="${2:-}"
                shift 2
                ;;
              --priority)
                priority_ref="${2:-}"
                shift 2
                ;;
              --labels)
                labels_raw="${2:-}"
                shift 2
                ;;
              *)
                die "unknown issue create argument: $1"
                ;;
            esac
          done
          [[ -n "$title" ]] || die "usage: issue create --title <title> ..."
          [[ -n "$body_mode" ]] || die "usage: issue create requires one of --file|--text|--stdin"
          [[ -n "$team_ref" ]] || die "usage: issue create requires --team <team>"
          cmd_issue_create "$title" "$body_mode" "$body_value" "$team_ref" "$project_ref" "$assignee_ref" "$state_ref" "$priority_ref" "$labels_raw"
          ;;
        update-description)
          [[ "$#" -ge 4 ]] || die "usage: issue update-description <issue-ref> (--file <path>|--text <text>|--stdin)"
          if [[ "$4" == "--stdin" ]]; then
            [[ "$#" -eq 4 ]] || die "usage: issue update-description <issue-ref> --stdin"
            cmd_issue_update_description "$3" "$4"
          else
            [[ "$#" -eq 5 ]] || die "usage: issue update-description <issue-ref> (--file <path>|--text <text>)"
            cmd_issue_update_description "$3" "$4" "$5"
          fi
          ;;
        add-comment)
          [[ "$#" -ge 4 ]] || die "usage: issue add-comment <issue-ref> (--file <path>|--text <text>|--stdin)"
          if [[ "$4" == "--stdin" ]]; then
            [[ "$#" -eq 4 ]] || die "usage: issue add-comment <issue-ref> --stdin"
            cmd_issue_add_comment "$3" "$4"
          else
            [[ "$#" -eq 5 ]] || die "usage: issue add-comment <issue-ref> (--file <path>|--text <text>)"
            cmd_issue_add_comment "$3" "$4" "$5"
          fi
          ;;
        add-attachment)
          [[ "$#" -ge 4 && "$#" -le 6 ]] || die "usage: issue add-attachment <issue-ref> <url> [title] [subtitle]"
          cmd_issue_add_attachment "$3" "$4" "${5:-}" "${6:-}"
          ;;
        ensure-label)
          [[ "$#" -eq 4 ]] || die "usage: issue ensure-label <issue-ref> <label-name>"
          cmd_issue_ensure_label "$3" "$4"
          ;;
        *)
          die "unknown issue command: $2"
          ;;
      esac
      ;;
    probe-write)
      [[ "$#" -eq 2 ]] || die "usage: probe-write <issue-ref>"
      cmd_probe_write "$2"
      ;;
    probe-auth)
      [[ "$#" -eq 1 ]] || die "usage: probe-auth"
      cmd_probe_auth
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      die "unknown command: $1"
      ;;
  esac
}

main "$@"
