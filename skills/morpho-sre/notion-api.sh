#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib-notion-api.sh
. "${SCRIPT_DIR}/lib-notion-api.sh"

usage() {
  cat <<'EOF'
Usage:
  notion-api.sh --probe-auth
  notion-api.sh --print-plan
  notion-api.sh me
  notion-api.sh users [--page-size N] [--start-cursor CURSOR]
  notion-api.sh search --query TEXT [--filter page|data_source] [--page-size N] [--start-cursor CURSOR]
  notion-api.sh database get <database-id-or-url>
  notion-api.sh data-source get <data-source-id-or-url>
  notion-api.sh data-source query <data-source-id-or-url> [--body-file FILE] [--filter-properties PROPERTY_ID_CSV] [--page-size N] [--start-cursor CURSOR] [--result-type page|data_source]
  notion-api.sh page get <page-id-or-url> [--filter-properties PROPERTY_ID_CSV]
  notion-api.sh page property <page-id-or-url> <property-id> [--page-size N] [--start-cursor CURSOR]
  notion-api.sh page blocks <page-or-block-id-or-url> [--page-size N] [--start-cursor CURSOR]
  notion-api.sh page markdown <page-id-or-url> [--include-transcript]

Read-only wrapper for the Notion REST API.

Credential chain:
  1. NOTION_SECRET
  2. NOTION_TOKEN
  3. Vault token fast path (VAULT_ADDR + VAULT_TOKEN + secret/data/openclaw-sre/all-secrets)
  4. Vault Kubernetes JWT auth slow path

Notes:
  - Search is title-oriented. For row filtering inside a database/data source, use
    "data-source query" instead of "search".
  - Search requires `--query` to avoid workspace-wide enumeration.
  - `--filter-properties` expects Notion property IDs, not display names.
  - Internal integrations must still be shared with the target page/database in Notion.
  - Default Notion version is pinned to 2025-09-03 for data-source compatibility.
    Override with NOTION_API_VERSION if needed.
EOF
}

require_option_value() {
  local flag="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || die "${flag} requires a value"
}

main() {
  require_cmd "$NOTION_CURL_BIN"
  require_cmd "$NOTION_JQ_BIN"

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
      notion_request GET '/users/me' ''
      ;;
    users)
      shift
      local page_size="" start_cursor=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --page-size)
            require_option_value '--page-size' "${2:-}"
            page_size="$(validate_page_size "${2:-}")"
            shift 2
            ;;
          --start-cursor)
            require_option_value '--start-cursor' "${2:-}"
            start_cursor="${2:-}"
            shift 2
            ;;
          *)
            die "unknown users option: $1"
            ;;
        esac
      done
      notion_request GET '/users' '' start_cursor "$start_cursor" page_size "$page_size"
      ;;
    search)
      shift
      local query="" filter="" page_size="" start_cursor=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --query)
            require_option_value '--query' "${2:-}"
            query="${2:-}"
            shift 2
            ;;
          --filter)
            require_option_value '--filter' "${2:-}"
            filter="${2:-}"
            # Notion's 2025-09-03 API version uses `data_source` here; older versions used `database`.
            [[ "$filter" == "page" || "$filter" == "data_source" ]] || {
              die "search --filter must be page or data_source"
            }
            shift 2
            ;;
          --page-size)
            require_option_value '--page-size' "${2:-}"
            page_size="$(validate_page_size "${2:-}")"
            shift 2
            ;;
          --start-cursor)
            require_option_value '--start-cursor' "${2:-}"
            start_cursor="${2:-}"
            shift 2
            ;;
          *)
            die "unknown search option: $1"
            ;;
        esac
      done
      [[ -n "$query" ]] || die 'search --query is required'
      notion_request POST '/search' "$(build_search_body "$query" "$filter" "$page_size" "$start_cursor")"
      ;;
    database)
      [[ "${2:-}" == "get" ]] || die "usage: notion-api.sh database get <database-id-or-url>"
      [[ -n "${3:-}" ]] || die "usage: notion-api.sh database get <database-id-or-url>"
      notion_request GET "/databases/$(normalize_notion_id "$3")" ''
      ;;
    data-source)
      # /data_sources/* requires Notion-Version 2025-09-03 or newer.
      case "${2:-}" in
        get)
          [[ -n "${3:-}" ]] || die "usage: notion-api.sh data-source get <data-source-id-or-url>"
          notion_request GET "/data_sources/$(normalize_notion_id "$3")" ''
          ;;
        query)
          [[ -n "${3:-}" ]] || die "usage: notion-api.sh data-source query <data-source-id-or-url> [options]"
          local data_source_id body_file="" filter_properties="" page_size="" start_cursor="" result_type=""
          data_source_id="$(normalize_notion_id "$3")"
          shift 3
          while [[ $# -gt 0 ]]; do
            case "$1" in
              --body-file)
                require_option_value '--body-file' "${2:-}"
                body_file="${2:-}"
                shift 2
                ;;
              --filter-properties)
                require_option_value '--filter-properties' "${2:-}"
                filter_properties="${2:-}"
                shift 2
                ;;
              --page-size)
                require_option_value '--page-size' "${2:-}"
                page_size="$(validate_page_size "${2:-}")"
                shift 2
                ;;
              --start-cursor)
                require_option_value '--start-cursor' "${2:-}"
                start_cursor="${2:-}"
                shift 2
                ;;
              --result-type)
                require_option_value '--result-type' "${2:-}"
                result_type="${2:-}"
                [[ "$result_type" == "page" || "$result_type" == "data_source" ]] || {
                  die "data-source query --result-type must be page or data_source"
                }
                shift 2
                ;;
              *)
                die "unknown data-source query option: $1"
                ;;
            esac
          done
          local -a args=()
          local property_id=""
          while IFS= read -r property; do
            [[ -n "$property" ]] || continue
            property_id="$(validate_property_id "$property")"
            args+=( 'filter_properties[]' "$property_id" )
          done < <(parse_csv_values "$filter_properties")
          if (( ${#args[@]} > 0 )); then
            notion_request \
              POST \
              "/data_sources/${data_source_id}/query" \
              "$(build_data_source_query_body "$body_file" "$page_size" "$start_cursor" "$result_type")" \
              "${args[@]}"
          else
            notion_request \
              POST \
              "/data_sources/${data_source_id}/query" \
              "$(build_data_source_query_body "$body_file" "$page_size" "$start_cursor" "$result_type")"
          fi
          ;;
        *)
          die "usage: notion-api.sh data-source <get|query> ..."
          ;;
      esac
      ;;
    page)
      case "${2:-}" in
        get)
          [[ -n "${3:-}" ]] || die "usage: notion-api.sh page get <page-id-or-url> [--filter-properties PROPERTY_ID_CSV]"
          local page_id filter_properties=""
          page_id="$(normalize_notion_id "$3")"
          shift 3
          while [[ $# -gt 0 ]]; do
            case "$1" in
              --filter-properties)
                require_option_value '--filter-properties' "${2:-}"
                filter_properties="${2:-}"
                shift 2
                ;;
              *)
                die "unknown page get option: $1"
                ;;
            esac
          done
          local -a args=()
          local property_id=""
          while IFS= read -r property; do
            [[ -n "$property" ]] || continue
            property_id="$(validate_property_id "$property")"
            args+=( 'filter_properties[]' "$property_id" )
          done < <(parse_csv_values "$filter_properties")
          if (( ${#args[@]} > 0 )); then
            notion_request GET "/pages/${page_id}" '' "${args[@]}"
          else
            notion_request GET "/pages/${page_id}" ''
          fi
          ;;
        property)
          [[ -n "${3:-}" && -n "${4:-}" ]] || {
            die "usage: notion-api.sh page property <page-id-or-url> <property-id> [--page-size N] [--start-cursor CURSOR]"
          }
          local property_page_id property_id encoded_property_id page_size="" start_cursor=""
          property_page_id="$(normalize_notion_id "$3")"
          property_id="$(validate_property_id "$4")"
          encoded_property_id="$(urlencode_preserving_pct_encoded "$property_id")" || {
            die 'failed to URL-encode page property id'
          }
          shift 4
          while [[ $# -gt 0 ]]; do
            case "$1" in
              --page-size)
                require_option_value '--page-size' "${2:-}"
                page_size="$(validate_page_size "${2:-}")"
                shift 2
                ;;
              --start-cursor)
                require_option_value '--start-cursor' "${2:-}"
                start_cursor="${2:-}"
                shift 2
                ;;
              *)
                die "unknown page property option: $1"
                ;;
            esac
          done
          notion_request \
            GET \
            "/pages/${property_page_id}/properties/${encoded_property_id}" \
            '' \
            start_cursor "$start_cursor" \
            page_size "$page_size"
          ;;
        blocks)
          [[ -n "${3:-}" ]] || {
            die "usage: notion-api.sh page blocks <page-or-block-id-or-url> [--page-size N] [--start-cursor CURSOR]"
          }
          local block_id page_size="" start_cursor=""
          block_id="$(normalize_notion_id "$3")"
          shift 3
          while [[ $# -gt 0 ]]; do
            case "$1" in
              --page-size)
                require_option_value '--page-size' "${2:-}"
                page_size="$(validate_page_size "${2:-}")"
                shift 2
                ;;
              --start-cursor)
                require_option_value '--start-cursor' "${2:-}"
                start_cursor="${2:-}"
                shift 2
                ;;
              *)
                die "unknown page blocks option: $1"
                ;;
            esac
          done
          notion_request \
            GET \
            "/blocks/${block_id}/children" \
            '' \
            start_cursor "$start_cursor" \
            page_size "$page_size"
          ;;
        markdown)
          [[ -n "${3:-}" ]] || {
            die "usage: notion-api.sh page markdown <page-id-or-url> [--include-transcript]"
          }
          local markdown_page_id include_transcript=""
          markdown_page_id="$(normalize_notion_id "$3")"
          shift 3
          while [[ $# -gt 0 ]]; do
            case "$1" in
              --include-transcript)
                include_transcript="true"
                shift
                ;;
              *)
                die "unknown page markdown option: $1"
                ;;
            esac
          done
          notion_request \
            GET \
            "/pages/${markdown_page_id}/markdown" \
            '' \
            include_transcript "$include_transcript"
          ;;
        *)
          die "usage: notion-api.sh page <get|property|blocks|markdown> ..."
          ;;
      esac
      ;;
    *)
      die "unknown command: $1"
      ;;
  esac
}

main "$@"
