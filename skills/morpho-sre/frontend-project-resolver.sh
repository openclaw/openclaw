#!/usr/bin/env bash
set -euo pipefail

JQ_BIN="${JQ_BIN:-jq}"

die() {
  printf 'frontend-project-resolver: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

trim() {
  printf '%s' "${1:-}" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g'
}

resolve_env_value() {
  local prefix="$1"
  local env_name="$2"
  local suffix
  suffix="$(printf '%s' "$env_name" | tr '[:lower:]' '[:upper:]')"
  local var_name="${prefix}_${suffix}"
  local value="${!var_name:-}"
  printf '%s' "$(trim "$value")"
}

normalize_env_name() {
  case "${1:-}" in
    dev|DEV) printf 'dev\n' ;;
    prd|PRD|prod|PROD) printf 'prd\n' ;;
    *) return 1 ;;
  esac
}

default_project_map_json() {
  local ids_csv="$1"
  if [[ -z "$ids_csv" ]]; then
    printf '{}\n'
    return 0
  fi

  printf '%s\n' "$ids_csv" | "$JQ_BIN" -Rsc '
    split(",")
    | map(gsub("^\\s+|\\s+$"; "") | select(length > 0))
    | reduce .[] as $value ({}; .[$value] = {aliases: [$value]})
  '
}

normalized_map_json() {
  local raw_json="$1"
  local fallback_json="$2"

  if [[ -z "$raw_json" ]]; then
    printf '%s\n' "$fallback_json"
    return 0
  fi

  printf '%s\n' "$raw_json" | "$JQ_BIN" -c '
    if type != "object" then
      error("project map must be an object")
    else
      with_entries(
        .value = (
          if (.value | type) == "object" then
            .value
          else
            {aliases: [(.key | tostring)]}
          end
        )
      )
    end
  ' 2>/dev/null || die "invalid project map JSON"
}

score_map() {
  local kind="$1"
  local map_json="$2"
  local prompt_text="$3"

  printf '%s\n' "$map_json" | "$JQ_BIN" -c \
    --arg kind "$kind" \
    --arg prompt "$prompt_text" '
      to_entries
      | map(
          . as $entry
          | ($entry.value.aliases // []) as $aliases
          | ($aliases | map(tostring | ascii_downcase | gsub("^\\s+|\\s+$"; "") | select(length > 0))) as $normalizedAliases
          | ($normalizedAliases | reduce .[] as $alias (0; . + (if ($prompt | contains($alias)) then 1 else 0 end))) as $score
          | select($score > 0)
          | {
              kind: $kind,
              key: $entry.key,
              score: $score,
              aliases: $normalizedAliases,
              config: $entry.value
            }
        )
      | sort_by(-.score, .key)
    '
}

main() {
  local env_name
  local prompt_text
  local posthog_map_raw
  local sentry_map_raw
  local posthog_fallback
  local sentry_fallback
  local posthog_map
  local sentry_map
  local prompt_normalized

  require_cmd "$JQ_BIN"

  env_name="$(normalize_env_name "${1:-}")" || die "usage: frontend-project-resolver.sh <dev|prd> [question text]"
  shift || true
  if [[ "$#" -gt 0 ]]; then
    prompt_text="$*"
  else
    prompt_text="$(cat)"
  fi
  prompt_text="$(trim "$prompt_text")"
  [[ -n "$prompt_text" ]] || die "missing question text"
  prompt_normalized="$(printf '%s' "$prompt_text" | tr '[:upper:]' '[:lower:]')"

  posthog_map_raw="$(resolve_env_value POSTHOG_PROJECT_MAP "$env_name")"
  sentry_map_raw="$(resolve_env_value SENTRY_PROJECT_MAP "$env_name")"
  posthog_fallback="$(default_project_map_json "$(resolve_env_value POSTHOG_PROJECT_ID "$env_name")")"
  sentry_fallback="$(default_project_map_json "$(resolve_env_value SENTRY_PROJECT_SLUGS "$env_name")")"
  posthog_map="$(normalized_map_json "$posthog_map_raw" "$posthog_fallback")"
  sentry_map="$(normalized_map_json "$sentry_map_raw" "$sentry_fallback")"

  "$JQ_BIN" -nc \
    --arg envName "$env_name" \
    --arg prompt "$prompt_text" \
    --argjson posthogMap "$posthog_map" \
    --argjson sentryMap "$sentry_map" \
    --argjson posthogMatches "$(score_map posthog "$posthog_map" "$prompt_normalized")" \
    --argjson sentryMatches "$(score_map sentry "$sentry_map" "$prompt_normalized")" '
      {
        env: $envName,
        prompt: $prompt,
        posthog: {
          matches: $posthogMatches,
          top: ($posthogMatches[0] // null)
        },
        sentry: {
          matches: $sentryMatches,
          top: ($sentryMatches[0] // null)
        }
      }
    '
}

main "$@"
