#!/usr/bin/env bash
set -euo pipefail

# Trim leading/trailing whitespace for robust .env parsing.
trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# Remove one pair of matching outer quotes if present.
strip_outer_quotes() {
  local value="$1"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    printf '%s' "${value:1:${#value}-2}"
    return
  fi
  if [[ "$value" == \'*\' && "$value" == *\' ]]; then
    printf '%s' "${value:1:${#value}-2}"
    return
  fi
  printf '%s' "$value"
}

# Parse KEY=value (with optional "export") and return the normalized value.
parse_env_assignment() {
  local key="$1"
  local line="$2"
  local parsed=""
  if [[ "$line" =~ ^(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*(.*)$ ]]; then
    parsed="$(trim "${BASH_REMATCH[2]}")"
    parsed="$(strip_outer_quotes "$parsed")"
  fi
  printf '%s' "$parsed"
}

# Return the last occurrence of KEY from an env-style file.
read_last_env_value() {
  local file_path="$1"
  local key="$2"
  local line=""
  local trimmed=""
  local parsed=""
  local last_value=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim "$line")"
    if [[ -z "$trimmed" || "$trimmed" == \#* ]]; then
      continue
    fi
    parsed="$(parse_env_assignment "$key" "$trimmed")"
    if [[ -n "$parsed" ]]; then
      last_value="$parsed"
    fi
  done < "$file_path"

  printf '%s' "$last_value"
}

# Bash 3-compatible membership test for small token lists.
contains_token() {
  local needle="$1"
  shift
  local candidate=""
  for candidate in "$@"; do
    if [[ "$candidate" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

# Mask token output so logs never leak full credentials.
mask_token() {
  local token="$1"
  local len=${#token}
  if (( len <= 4 )); then
    printf '****'
    return
  fi
  if (( len <= 8 )); then
    printf '%s...%s' "${token:0:1}" "${token:len-1:1}"
    return
  fi
  printf '%s...%s' "${token:0:4}" "${token:len-4:4}"
}

if [[ ! -r ".env.bots" ]]; then
  echo "Error: .env.bots not found or not readable in $(pwd)." >&2
  echo "Create it from .env.bots.example and add BOT_TOKEN entries." >&2
  exit 1
fi

bot_tokens=()
line=""
trimmed=""
parsed=""
while IFS= read -r line || [[ -n "$line" ]]; do
  trimmed="$(trim "$line")"
  if [[ -z "$trimmed" || "$trimmed" == \#* ]]; then
    continue
  fi
  parsed="$(parse_env_assignment "BOT_TOKEN" "$trimmed")"
  if [[ -n "$parsed" ]]; then
    bot_tokens+=("$parsed")
  fi
done < ".env.bots"

if (( ${#bot_tokens[@]} == 0 )); then
  echo "Error: no valid BOT_TOKEN entries found in .env.bots." >&2
  exit 1
fi

worktree_paths=()
worktree_list_output=""
if ! worktree_list_output="$(git worktree list --porcelain 2>/dev/null)"; then
  echo "Error: unable to list git worktrees from $(pwd)." >&2
  echo "Run this script from within a git worktree." >&2
  exit 1
fi

while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == worktree\ * ]]; then
    worktree_paths+=("${line#worktree }")
  fi
done <<< "$worktree_list_output"

claimed_tokens=()
worktree_path=""
env_local_path=""
claimed=""
for worktree_path in "${worktree_paths[@]-}"; do
  env_local_path="$worktree_path/.env.local"
  if [[ ! -f "$env_local_path" ]]; then
    continue
  fi
  claimed="$(read_last_env_value "$env_local_path" "TELEGRAM_BOT_TOKEN")"
  if [[ -n "$claimed" ]]; then
    claimed_tokens+=("$claimed")
  fi
done

selected_token=""
selected_index=0
idx=0
for idx in "${!bot_tokens[@]}"; do
  if ! contains_token "${bot_tokens[$idx]}" "${claimed_tokens[@]-}"; then
    selected_token="${bot_tokens[$idx]}"
    selected_index=$((idx + 1))
    break
  fi
done

if [[ -z "$selected_token" ]]; then
  echo "Error: no unclaimed bot tokens available." >&2
  echo "Claimed: ${#claimed_tokens[@]} / Total: ${#bot_tokens[@]}" >&2
  echo "Delete an unused worktree .env.local to free a token." >&2
  exit 1
fi

printf 'TELEGRAM_BOT_TOKEN=%s\n' "$selected_token" > ".env.local"

echo "Assigned Telegram bot token #$selected_index to worktree: $(pwd -P)"
echo "Token fingerprint: $(mask_token "$selected_token")"
