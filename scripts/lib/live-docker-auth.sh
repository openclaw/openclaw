#!/usr/bin/env bash

OPENCLAW_DOCKER_LIVE_AUTH_ALL=(.codex .minimax)
OPENCLAW_DOCKER_LIVE_AUTH_FILES_ALL=(
  .claude.json
  .claude/.credentials.json
  .claude/settings.json
  .claude/settings.local.json
)

openclaw_live_trim() {
  local value="${1:-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

openclaw_live_normalize_auth_dir() {
  local value
  value="$(openclaw_live_trim "${1:-}")"
  [[ -n "$value" ]] || return 1
  value="${value#.}"
  printf '.%s' "$value"
}

openclaw_live_should_include_auth_dir_for_provider() {
  local provider
  provider="$(openclaw_live_trim "${1:-}")"
  case "$provider" in
    codex-cli | openai-codex)
      printf '%s\n' ".codex"
      ;;
    minimax | minimax-portal)
      printf '%s\n' ".minimax"
      ;;
  esac
}

openclaw_live_should_include_auth_file_for_provider() {
  local provider
  provider="$(openclaw_live_trim "${1:-}")"
  case "$provider" in
    anthropic)
      printf '%s\n' ".claude.json"
      printf '%s\n' ".claude/.credentials.json"
      printf '%s\n' ".claude/settings.json"
      printf '%s\n' ".claude/settings.local.json"
      ;;
  esac
}

openclaw_live_collect_auth_dirs_from_csv() {
  local raw="${1:-}"
  local token normalized
  [[ -n "$(openclaw_live_trim "$raw")" ]] || return 0
  IFS=',' read -r -a tokens <<<"$raw"
  for token in "${tokens[@]}"; do
    while IFS= read -r normalized; do
      printf '%s\n' "$normalized"
    done < <(openclaw_live_should_include_auth_dir_for_provider "$token")
  done | awk 'NF && !seen[$0]++'
}

openclaw_live_collect_auth_dirs_from_override() {
  local raw token normalized
  raw="$(openclaw_live_trim "${OPENCLAW_DOCKER_AUTH_DIRS:-}")"
  [[ -n "$raw" ]] || return 1
  case "$raw" in
    all)
      printf '%s\n' "${OPENCLAW_DOCKER_LIVE_AUTH_ALL[@]}"
      return 0
      ;;
    none)
      return 0
      ;;
  esac
  IFS=',' read -r -a tokens <<<"$raw"
  for token in "${tokens[@]}"; do
    normalized="$(openclaw_live_normalize_auth_dir "$token")" || continue
    printf '%s\n' "$normalized"
  done | awk '!seen[$0]++'
  return 0
}

openclaw_live_collect_auth_dirs() {
  if openclaw_live_collect_auth_dirs_from_override; then
    return 0
  fi
  printf '%s\n' "${OPENCLAW_DOCKER_LIVE_AUTH_ALL[@]}"
}

openclaw_live_collect_auth_files_from_csv() {
  local raw="${1:-}"
  local token normalized
  [[ -n "$(openclaw_live_trim "$raw")" ]] || return 0
  IFS=',' read -r -a tokens <<<"$raw"
  for token in "${tokens[@]}"; do
    while IFS= read -r normalized; do
      printf '%s\n' "$normalized"
    done < <(openclaw_live_should_include_auth_file_for_provider "$token")
  done | awk 'NF && !seen[$0]++'
}

openclaw_live_collect_auth_files_from_override() {
  local raw
  raw="$(openclaw_live_trim "${OPENCLAW_DOCKER_AUTH_DIRS:-}")"
  [[ -n "$raw" ]] || return 1
  case "$raw" in
    all)
      printf '%s\n' "${OPENCLAW_DOCKER_LIVE_AUTH_FILES_ALL[@]}"
      return 0
      ;;
    none)
      return 0
      ;;
  esac
  return 0
}

openclaw_live_collect_auth_files() {
  if openclaw_live_collect_auth_files_from_override; then
    return 0
  fi
  printf '%s\n' "${OPENCLAW_DOCKER_LIVE_AUTH_FILES_ALL[@]}"
}

openclaw_live_join_csv() {
  local first=1 value
  for value in "$@"; do
    [[ -n "$value" ]] || continue
    if (( first )); then
      printf '%s' "$value"
      first=0
    else
      printf ',%s' "$value"
    fi
  done
}
