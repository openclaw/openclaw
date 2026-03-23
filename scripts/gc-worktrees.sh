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

usage() {
  cat <<'EOF'
Usage: scripts/gc-worktrees.sh [--auto] [--include-detached] [--base-branch <branch>]
EOF
}

AUTO=0
INCLUDE_DETACHED=0
BASE_BRANCH="main"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --auto)
      AUTO=1
      shift
      ;;
    --include-detached)
      INCLUDE_DETACHED=1
      shift
      ;;
    --base-branch)
      if [[ $# -lt 2 ]]; then
        echo "Error: --base-branch requires a value." >&2
        exit 1
      fi
      BASE_BRANCH="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "Error: run this script from inside a git worktree." >&2
  exit 1
fi

git worktree prune

worktree_output="$(git worktree list --porcelain)"
if [[ -z "$worktree_output" ]]; then
  echo "Error: git worktree list returned no entries." >&2
  exit 1
fi

declare -a block_paths=()
declare -a block_branches=()
declare -a block_detached=()
declare -a block_prunable=()
declare -a display_classes=()
declare -a display_paths=()
declare -a display_tokens=()
declare -a remove_paths=()
declare -a release_paths=()

finalize_block() {
  if [[ -z "${current_path:-}" ]]; then
    return
  fi
  block_paths+=("$current_path")
  block_branches+=("${current_branch:-}")
  block_detached+=("${current_detached:-0}")
  block_prunable+=("${current_prunable:-0}")
}

current_path=""
current_branch=""
current_detached=0
current_prunable=0

while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ -z "$line" ]]; then
    finalize_block
    current_path=""
    current_branch=""
    current_detached=0
    current_prunable=0
    continue
  fi

  case "$line" in
    worktree\ *)
      current_path="${line#worktree }"
      ;;
    branch\ *)
      current_branch="${line#branch }"
      ;;
    detached)
      current_detached=1
      ;;
    prunable*)
      current_prunable=1
      ;;
  esac
done <<< "$worktree_output"
finalize_block

if (( ${#block_paths[@]} == 0 )); then
  echo "Error: no worktrees parsed from git worktree list." >&2
  exit 1
fi

main_worktree="${block_paths[0]}"
if [[ -d "$main_worktree" ]]; then
  main_worktree="$(cd "$main_worktree" && pwd -P)"
fi
current_worktree="$(git rev-parse --show-toplevel)"
if [[ -d "$current_worktree" ]]; then
  current_worktree="$(cd "$current_worktree" && pwd -P)"
fi

prunable_count=0
merged_count=0
detached_count=0
active_count=0
removed_count=0

for ((i = 1; i < ${#block_paths[@]}; i++)); do
  worktree_path="${block_paths[$i]}"
  branch_ref="${block_branches[$i]}"
  is_detached="${block_detached[$i]}"
  is_prunable="${block_prunable[$i]}"

  normalized_path="$worktree_path"
  if [[ -d "$worktree_path" ]]; then
    normalized_path="$(cd "$worktree_path" && pwd -P)"
  fi

  if [[ "$normalized_path" == "$main_worktree" || "$normalized_path" == "$current_worktree" ]]; then
    continue
  fi

  env_local_path="${normalized_path}/.env.local"
  token_display="-"
  if [[ -f "$env_local_path" ]]; then
    token_value="$(read_last_env_value "$env_local_path" "TELEGRAM_BOT_TOKEN")"
    if [[ -n "$token_value" ]]; then
      token_display="$(mask_token "$token_value")"
    fi
  fi

  class="active"
  should_remove=0
  should_release=0

  if [[ "$is_prunable" == "1" ]]; then
    class="prunable"
    prunable_count=$((prunable_count + 1))
    should_remove=1
  elif [[ "$is_detached" == "1" ]]; then
    class="detached"
    detached_count=$((detached_count + 1))
    if [[ "$INCLUDE_DETACHED" == "1" ]]; then
      should_remove=1
    fi
  elif [[ -n "$branch_ref" ]]; then
    if git merge-base --is-ancestor "$branch_ref" "$BASE_BRANCH" >/dev/null 2>&1; then
      class="merged"
      merged_count=$((merged_count + 1))
      should_remove=1
    else
      merge_status=$?
      if [[ "$merge_status" == "128" ]]; then
        class="active"
        active_count=$((active_count + 1))
      else
        class="active"
        active_count=$((active_count + 1))
      fi
    fi
  else
    class="active"
    active_count=$((active_count + 1))
  fi

  # Release is only meaningful when the worktree still exists and has its own
  # env-local claim file. Prunable entries often point at already-missing paths.
  if [[ "$should_remove" == "1" && -d "$normalized_path" && -f "$env_local_path" ]]; then
    claimed_token="$(read_last_env_value "$env_local_path" "TELEGRAM_BOT_TOKEN")"
    if [[ -n "$claimed_token" ]]; then
      should_release=1
    fi
  fi

  display_classes+=("$class")
  display_paths+=("$normalized_path")
  display_tokens+=("$token_display")
  if [[ "$should_remove" == "1" ]]; then
    remove_paths+=("$normalized_path")
  fi
  if [[ "$should_release" == "1" ]]; then
    release_paths+=("$normalized_path")
  fi
done

printf '%-10s %-18s %s\n' "CLASS" "BOT" "PATH"
for ((i = 0; i < ${#display_paths[@]}; i++)); do
  printf '%-10s %-18s %s\n' \
    "${display_classes[$i]}" \
    "${display_tokens[$i]}" \
    "${display_paths[$i]}"
done

if [[ "$AUTO" == "1" ]]; then
  for path in "${release_paths[@]}"; do
    if [[ -d "$path" ]]; then
      (cd "$path" && bash scripts/telegram-live-runtime.sh release) || true
    fi
  done

  for path in "${remove_paths[@]}"; do
    if git worktree remove --force "$path"; then
      removed_count=$((removed_count + 1))
    fi
  done
else
  echo "re-run with --auto to apply."
fi

echo "GC complete: ${prunable_count} prunable, ${merged_count} merged (${removed_count} removed), ${detached_count} detached, ${active_count} active"
