#!/usr/bin/env bash

MULLUSI_DOCKER_LIVE_AUTH_ALL=(.claude .codex .minimax)
MULLUSI_DOCKER_LIVE_AUTH_FILES_ALL=(.claude.json)

mullusi_live_trim() {
  local value="${1:-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

mullusi_live_normalize_auth_dir() {
  local value
  value="$(mullusi_live_trim "${1:-}")"
  [[ -n "$value" ]] || return 1
  value="${value#.}"
  printf '.%s' "$value"
}

mullusi_live_should_include_auth_dir_for_provider() {
  local provider
  provider="$(mullusi_live_trim "${1:-}")"
  case "$provider" in
    anthropic | claude-cli)
      printf '%s\n' ".claude"
      ;;
    codex-cli | openai-codex)
      printf '%s\n' ".codex"
      ;;
    minimax | minimax-portal)
      printf '%s\n' ".minimax"
      ;;
  esac
}

mullusi_live_should_include_auth_file_for_provider() {
  local provider
  provider="$(mullusi_live_trim "${1:-}")"
  case "$provider" in
    anthropic | claude-cli)
      printf '%s\n' ".claude.json"
      ;;
  esac
}

mullusi_live_collect_auth_dirs_from_csv() {
  local raw="${1:-}"
  local token normalized
  [[ -n "$(mullusi_live_trim "$raw")" ]] || return 0
  IFS=',' read -r -a tokens <<<"$raw"
  for token in "${tokens[@]}"; do
    while IFS= read -r normalized; do
      printf '%s\n' "$normalized"
    done < <(mullusi_live_should_include_auth_dir_for_provider "$token")
  done | awk 'NF && !seen[$0]++'
}

mullusi_live_collect_auth_dirs_from_override() {
  local raw token normalized
  raw="$(mullusi_live_trim "${MULLUSI_DOCKER_AUTH_DIRS:-}")"
  [[ -n "$raw" ]] || return 1
  case "$raw" in
    all)
      printf '%s\n' "${MULLUSI_DOCKER_LIVE_AUTH_ALL[@]}"
      return 0
      ;;
    none)
      return 0
      ;;
  esac
  IFS=',' read -r -a tokens <<<"$raw"
  for token in "${tokens[@]}"; do
    normalized="$(mullusi_live_normalize_auth_dir "$token")" || continue
    printf '%s\n' "$normalized"
  done | awk '!seen[$0]++'
  return 0
}

mullusi_live_collect_auth_dirs() {
  if mullusi_live_collect_auth_dirs_from_override; then
    return 0
  fi
  printf '%s\n' "${MULLUSI_DOCKER_LIVE_AUTH_ALL[@]}"
}

mullusi_live_collect_auth_files_from_csv() {
  local raw="${1:-}"
  local token normalized
  [[ -n "$(mullusi_live_trim "$raw")" ]] || return 0
  IFS=',' read -r -a tokens <<<"$raw"
  for token in "${tokens[@]}"; do
    while IFS= read -r normalized; do
      printf '%s\n' "$normalized"
    done < <(mullusi_live_should_include_auth_file_for_provider "$token")
  done | awk 'NF && !seen[$0]++'
}

mullusi_live_collect_auth_files_from_override() {
  local raw
  raw="$(mullusi_live_trim "${MULLUSI_DOCKER_AUTH_DIRS:-}")"
  [[ -n "$raw" ]] || return 1
  case "$raw" in
    all)
      printf '%s\n' "${MULLUSI_DOCKER_LIVE_AUTH_FILES_ALL[@]}"
      return 0
      ;;
    none)
      return 0
      ;;
  esac
  return 0
}

mullusi_live_collect_auth_files() {
  if mullusi_live_collect_auth_files_from_override; then
    return 0
  fi
  printf '%s\n' "${MULLUSI_DOCKER_LIVE_AUTH_FILES_ALL[@]}"
}

mullusi_live_join_csv() {
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
