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
  response="$(linear_graphql 'query($id:String!){ issue(id:$id){ id identifier title description labels { nodes { id name } } } }' "$vars_json")"
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

  if ! label_id="$(lookup_label_id_optional "$label_name" 2>/dev/null)"; then
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

usage() {
  cat <<'EOF'
Usage:
  linear-ticket-api.sh lookup <team|project|user|label> <name>
  linear-ticket-api.sh issue get <issue-ref>
  linear-ticket-api.sh issue update-description <issue-ref> (--file <path> | --text <text> | --stdin)
  linear-ticket-api.sh issue add-comment <issue-ref> (--file <path> | --text <text> | --stdin)
  linear-ticket-api.sh issue ensure-label <issue-ref> <label-name>
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
    -h|--help|help)
      usage
      ;;
    *)
      die "unknown command: $1"
      ;;
  esac
}

main "$@"
