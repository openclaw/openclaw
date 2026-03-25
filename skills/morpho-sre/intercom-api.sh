#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib-intercom-api.sh
. "${SCRIPT_DIR}/lib-intercom-api.sh"

usage() {
  cat <<'EOF'
Usage:
  intercom-api.sh --probe-auth
  intercom-api.sh --print-plan
  intercom-api.sh me
  intercom-api.sh admins list [--page N] [--per-page N]
  intercom-api.sh admins get <admin-id>
  intercom-api.sh contacts list [--per-page N] [--starting-after CURSOR]
  intercom-api.sh contacts get <contact-id>
  intercom-api.sh contacts search (--body-file FILE | --body JSON | --stdin) [--per-page N] [--starting-after CURSOR]
  intercom-api.sh contacts companies <contact-id>
  intercom-api.sh companies list [--page N] [--per-page N] [--name NAME] [--company-id REMOTE_ID] [--tag-id ID] [--segment-id ID]
  intercom-api.sh companies get <company-id>
  intercom-api.sh companies contacts <company-id>
  intercom-api.sh conversations list [--per-page N] [--starting-after CURSOR]
  intercom-api.sh conversations get <conversation-id>
  intercom-api.sh conversations search (--body-file FILE | --body JSON | --stdin) [--per-page N] [--starting-after CURSOR]
  intercom-api.sh ticket-types list [--per-page N] [--starting-after CURSOR]
  intercom-api.sh ticket-types get <ticket-type-id>
  intercom-api.sh tickets get <ticket-id>
  intercom-api.sh tickets search (--body-file FILE | --body JSON | --stdin) [--per-page N] [--starting-after CURSOR]
  intercom-api.sh raw get <path>
  intercom-api.sh raw post <path> (--body-file FILE | --body JSON | --stdin)

Read-only wrapper for the Intercom REST API.

Credential chain:
  1. INTERCOM_SECRET
  2. INTERCOM_TOKEN
  3. Vault token fast path (VAULT_ADDR + VAULT_TOKEN + secret/data/openclaw-sre/all-secrets)
  4. Vault Kubernetes JWT auth slow path

Env:
  INTERCOM_API_REGION      Optional: us|eu|au (default: us)
  INTERCOM_API_BASE_URL    Optional explicit base URL. Must stay on api(.eu|.au).intercom.io
  INTERCOM_API_VERSION     Optional Intercom-Version header (default: 2.14)
  INTERCOM_SECRET          Preferred API token env
  INTERCOM_TOKEN           Fallback API token env
  INTERCOM_VAULT_SECRET_PATH Optional Vault path (default: secret/data/openclaw-sre/all-secrets)

Examples:
  intercom-api.sh --probe-auth
  intercom-api.sh contacts list --per-page 25
  intercom-api.sh conversations get 123456789
  intercom-api.sh contacts search --body '{"query":{"operator":"AND","value":[]}}' --per-page 10
  intercom-api.sh raw get '/admins/activity_logs?page=1&per_page=5'
EOF
}

require_option_value() {
  local flag="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || die "${flag} requires a value"
}

read_search_body() {
  local body_file="$1"
  local body_inline="$2"
  local use_stdin="$3"
  local per_page="$4"
  local starting_after="$5"
  local body_json
  body_json="$(load_json_body_source "$body_file" "$body_inline" "$use_stdin")"
  merge_search_pagination "$body_json" "$per_page" "$starting_after"
}

main() {
  require_cmd "$INTERCOM_CURL_BIN"
  require_cmd "$INTERCOM_JQ_BIN"

  [[ $# -gt 0 ]] || {
    usage
    exit 1
  }

  case "${1:-}" in
    -h|--help|help)
      usage
      exit 0
      ;;
    --print-plan)
      print_plan
      exit 0
      ;;
    --probe-auth)
      probe_auth
      exit 0
      ;;
  esac

  load_secret

  case "${1:-}" in
    me)
      intercom_request GET '/me' ''
      ;;
    admins)
      case "${2:-}" in
        list)
          shift 2
          local page="" per_page=""
          while [[ $# -gt 0 ]]; do
            case "$1" in
              --page)
                require_option_value '--page' "${2:-}"
                page="$(validate_page_number "${2:-}")"
                shift 2
                ;;
              --per-page)
                require_option_value '--per-page' "${2:-}"
                per_page="$(validate_page_size "${2:-}")"
                shift 2
                ;;
              *)
                die "unknown admins list option: $1"
                ;;
            esac
          done
          intercom_request GET '/admins' '' page "$page" per_page "$per_page"
          ;;
        get)
          [[ -n "${3:-}" ]] || die 'usage: intercom-api.sh admins get <admin-id>'
          intercom_request GET "/admins/$(validate_intercom_id "$3")" ''
          ;;
        *)
          die 'usage: intercom-api.sh admins <list|get> ...'
          ;;
      esac
      ;;
    contacts)
      case "${2:-}" in
        list)
          shift 2
          local per_page="" starting_after=""
          while [[ $# -gt 0 ]]; do
            case "$1" in
              --per-page)
                require_option_value '--per-page' "${2:-}"
                per_page="$(validate_page_size "${2:-}")"
                shift 2
                ;;
              --starting-after)
                require_option_value '--starting-after' "${2:-}"
                starting_after="$(validate_starting_after "${2:-}")"
                shift 2
                ;;
              *)
                die "unknown contacts list option: $1"
                ;;
            esac
          done
          intercom_request GET '/contacts' '' per_page "$per_page" starting_after "$starting_after"
          ;;
        get)
          [[ -n "${3:-}" ]] || die 'usage: intercom-api.sh contacts get <contact-id>'
          intercom_request GET "/contacts/$(validate_intercom_id "$3")" ''
          ;;
        search)
          shift 2
          local body_file="" body_inline="" use_stdin=0 per_page="" starting_after=""
          while [[ $# -gt 0 ]]; do
            case "$1" in
              --body-file)
                require_option_value '--body-file' "${2:-}"
                body_file="${2:-}"
                shift 2
                ;;
              --body)
                require_option_value '--body' "${2:-}"
                body_inline="${2:-}"
                shift 2
                ;;
              --stdin)
                use_stdin=1
                shift
                ;;
              --per-page)
                require_option_value '--per-page' "${2:-}"
                per_page="$(validate_page_size "${2:-}")"
                shift 2
                ;;
              --starting-after)
                require_option_value '--starting-after' "${2:-}"
                starting_after="$(validate_starting_after "${2:-}")"
                shift 2
                ;;
              *)
                die "unknown contacts search option: $1"
                ;;
            esac
          done
          intercom_request POST '/contacts/search' "$(read_search_body "$body_file" "$body_inline" "$use_stdin" "$per_page" "$starting_after")"
          ;;
        companies)
          [[ -n "${3:-}" ]] || die 'usage: intercom-api.sh contacts companies <contact-id>'
          intercom_request GET "/contacts/$(validate_intercom_id "$3")/companies" ''
          ;;
        *)
          die 'usage: intercom-api.sh contacts <list|get|search|companies> ...'
          ;;
      esac
      ;;
    companies)
      case "${2:-}" in
        list)
          shift 2
          local page="" per_page="" name="" company_id="" tag_id="" segment_id=""
          while [[ $# -gt 0 ]]; do
            case "$1" in
              --page)
                require_option_value '--page' "${2:-}"
                page="$(validate_page_number "${2:-}")"
                shift 2
                ;;
              --per-page)
                require_option_value '--per-page' "${2:-}"
                per_page="$(validate_page_size "${2:-}")"
                shift 2
                ;;
              --name)
                require_option_value '--name' "${2:-}"
                name="${2:-}"
                shift 2
                ;;
              --company-id)
                require_option_value '--company-id' "${2:-}"
                company_id="${2:-}"
                shift 2
                ;;
              --tag-id)
                require_option_value '--tag-id' "${2:-}"
                tag_id="$(validate_intercom_id "${2:-}")"
                shift 2
                ;;
              --segment-id)
                require_option_value '--segment-id' "${2:-}"
                segment_id="$(validate_intercom_id "${2:-}")"
                shift 2
                ;;
              *)
                die "unknown companies list option: $1"
                ;;
            esac
          done
          intercom_request GET '/companies' '' \
            page "$page" \
            per_page "$per_page" \
            name "$name" \
            company_id "$company_id" \
            tag_id "$tag_id" \
            segment_id "$segment_id"
          ;;
        get)
          [[ -n "${3:-}" ]] || die 'usage: intercom-api.sh companies get <company-id>'
          intercom_request GET "/companies/$(validate_intercom_id "$3")" ''
          ;;
        contacts)
          [[ -n "${3:-}" ]] || die 'usage: intercom-api.sh companies contacts <company-id>'
          intercom_request GET "/companies/$(validate_intercom_id "$3")/contacts" ''
          ;;
        *)
          die 'usage: intercom-api.sh companies <list|get|contacts> ...'
          ;;
      esac
      ;;
    conversations)
      case "${2:-}" in
        list)
          shift 2
          local per_page="" starting_after=""
          while [[ $# -gt 0 ]]; do
            case "$1" in
              --per-page)
                require_option_value '--per-page' "${2:-}"
                per_page="$(validate_page_size "${2:-}")"
                shift 2
                ;;
              --starting-after)
                require_option_value '--starting-after' "${2:-}"
                starting_after="$(validate_starting_after "${2:-}")"
                shift 2
                ;;
              *)
                die "unknown conversations list option: $1"
                ;;
            esac
          done
          intercom_request GET '/conversations' '' per_page "$per_page" starting_after "$starting_after"
          ;;
        get)
          [[ -n "${3:-}" ]] || die 'usage: intercom-api.sh conversations get <conversation-id>'
          intercom_request GET "/conversations/$(validate_intercom_id "$3")" ''
          ;;
        search)
          shift 2
          local body_file="" body_inline="" use_stdin=0 per_page="" starting_after=""
          while [[ $# -gt 0 ]]; do
            case "$1" in
              --body-file)
                require_option_value '--body-file' "${2:-}"
                body_file="${2:-}"
                shift 2
                ;;
              --body)
                require_option_value '--body' "${2:-}"
                body_inline="${2:-}"
                shift 2
                ;;
              --stdin)
                use_stdin=1
                shift
                ;;
              --per-page)
                require_option_value '--per-page' "${2:-}"
                per_page="$(validate_page_size "${2:-}")"
                shift 2
                ;;
              --starting-after)
                require_option_value '--starting-after' "${2:-}"
                starting_after="$(validate_starting_after "${2:-}")"
                shift 2
                ;;
              *)
                die "unknown conversations search option: $1"
                ;;
            esac
          done
          intercom_request POST '/conversations/search' "$(read_search_body "$body_file" "$body_inline" "$use_stdin" "$per_page" "$starting_after")"
          ;;
        *)
          die 'usage: intercom-api.sh conversations <list|get|search> ...'
          ;;
      esac
      ;;
    ticket-types)
      case "${2:-}" in
        list)
          shift 2
          local per_page="" starting_after=""
          while [[ $# -gt 0 ]]; do
            case "$1" in
              --per-page)
                require_option_value '--per-page' "${2:-}"
                per_page="$(validate_page_size "${2:-}")"
                shift 2
                ;;
              --starting-after)
                require_option_value '--starting-after' "${2:-}"
                starting_after="$(validate_starting_after "${2:-}")"
                shift 2
                ;;
              *)
                die "unknown ticket-types list option: $1"
                ;;
            esac
          done
          intercom_request GET '/ticket_types' '' per_page "$per_page" starting_after "$starting_after"
          ;;
        get)
          [[ -n "${3:-}" ]] || die 'usage: intercom-api.sh ticket-types get <ticket-type-id>'
          intercom_request GET "/ticket_types/$(validate_intercom_id "$3")" ''
          ;;
        *)
          die 'usage: intercom-api.sh ticket-types <list|get> ...'
          ;;
      esac
      ;;
    tickets)
      case "${2:-}" in
        get)
          [[ -n "${3:-}" ]] || die 'usage: intercom-api.sh tickets get <ticket-id>'
          intercom_request GET "/tickets/$(validate_intercom_id "$3")" ''
          ;;
        search)
          shift 2
          local body_file="" body_inline="" use_stdin=0 per_page="" starting_after=""
          while [[ $# -gt 0 ]]; do
            case "$1" in
              --body-file)
                require_option_value '--body-file' "${2:-}"
                body_file="${2:-}"
                shift 2
                ;;
              --body)
                require_option_value '--body' "${2:-}"
                body_inline="${2:-}"
                shift 2
                ;;
              --stdin)
                use_stdin=1
                shift
                ;;
              --per-page)
                require_option_value '--per-page' "${2:-}"
                per_page="$(validate_page_size "${2:-}")"
                shift 2
                ;;
              --starting-after)
                require_option_value '--starting-after' "${2:-}"
                starting_after="$(validate_starting_after "${2:-}")"
                shift 2
                ;;
              *)
                die "unknown tickets search option: $1"
                ;;
            esac
          done
          intercom_request POST '/tickets/search' "$(read_search_body "$body_file" "$body_inline" "$use_stdin" "$per_page" "$starting_after")"
          ;;
        *)
          die 'usage: intercom-api.sh tickets <get|search> ...'
          ;;
      esac
      ;;
    raw)
      case "${2:-}" in
        get)
          [[ -n "${3:-}" ]] || die 'usage: intercom-api.sh raw get <path>'
          validate_readonly_raw_path GET "$3"
          intercom_request GET "$3" ''
          ;;
        post)
          shift 2
          [[ -n "${1:-}" ]] || die 'usage: intercom-api.sh raw post <path> (--body-file FILE | --body JSON | --stdin)'
          local raw_path="$1"
          shift
          local body_file="" body_inline="" use_stdin=0
          while [[ $# -gt 0 ]]; do
            case "$1" in
              --body-file)
                require_option_value '--body-file' "${2:-}"
                body_file="${2:-}"
                shift 2
                ;;
              --body)
                require_option_value '--body' "${2:-}"
                body_inline="${2:-}"
                shift 2
                ;;
              --stdin)
                use_stdin=1
                shift
                ;;
              *)
                die "unknown raw post option: $1"
                ;;
            esac
          done
          validate_readonly_raw_path POST "$raw_path"
          intercom_request POST "$raw_path" "$(load_json_body_source "$body_file" "$body_inline" "$use_stdin")"
          ;;
        *)
          die 'usage: intercom-api.sh raw <get|post> ...'
          ;;
      esac
      ;;
    *)
      die "unknown command: $1"
      ;;
  esac
}

main "$@"
