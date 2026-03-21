#!/bin/bash

# Git Worktree Manager
# Handles creating, listing, switching, and cleaning up Git worktrees
# KISS principle: Simple, interactive, opinionated

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get repo root
GIT_ROOT=$(git rev-parse --show-toplevel)
WORKTREE_DIR="$GIT_ROOT/.worktrees"

# Ensure .worktrees is in .gitignore
ensure_gitignore() {
  if ! grep -q "^\.worktrees$" "$GIT_ROOT/.gitignore" 2>/dev/null; then
    echo ".worktrees" >> "$GIT_ROOT/.gitignore"
  fi
}

# Copy .env files from main repo to worktree
copy_env_files() {
  local worktree_path="$1"

  echo -e "${BLUE}Copying environment files...${NC}"

  # Find all .env* files in root (excluding .env.example which should be in git)
  local env_files=()
  for f in "$GIT_ROOT"/.env*; do
    if [[ -f "$f" ]]; then
      local basename=$(basename "$f")
      # Skip .env.example (that's typically committed to git)
      if [[ "$basename" != ".env.example" ]]; then
        env_files+=("$basename")
      fi
    fi
  done

  if [[ ${#env_files[@]} -eq 0 ]]; then
    echo -e "  ${YELLOW}ℹ️  No .env files found in main repository${NC}"
    return
  fi

  local copied=0
  for env_file in "${env_files[@]}"; do
    local source="$GIT_ROOT/$env_file"
    local dest="$worktree_path/$env_file"

    if [[ -f "$dest" ]]; then
      echo -e "  ${YELLOW}⚠️  $env_file already exists, backing up to ${env_file}.backup${NC}"
      cp "$dest" "${dest}.backup"
    fi

    cp "$source" "$dest"
    echo -e "  ${GREEN}✓ Copied $env_file${NC}"
    copied=$((copied + 1))
  done

  echo -e "  ${GREEN}✓ Copied $copied environment file(s)${NC}"
}

# Resolve the repository default branch, falling back to main when origin/HEAD
# is unavailable (for example in single-branch clones).
get_default_branch() {
  local head_ref
  head_ref=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || true)

  if [[ -n "$head_ref" ]]; then
    echo "${head_ref#refs/remotes/origin/}"
  else
    echo "main"
  fi
}

# Auto-trust is only safe when the worktree is created from a long-lived branch
# the developer already controls. Review/PR branches should fall back to the
# default branch baseline and require manual direnv approval.
is_trusted_base_branch() {
  local branch="$1"
  local default_branch="$2"

  [[ "$branch" == "$default_branch" ]] && return 0

  case "$branch" in
    develop|dev|trunk|staging|release/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# Trust development tool configs in a new worktree.
# Worktrees get a new filesystem path that tools like mise and direnv
# have never seen. Without trusting, these tools block with interactive
# prompts or refuse to load configs, which breaks hooks and scripts.
#
# Safety: auto-trusts only configs unchanged from a trusted baseline branch.
# Review/PR branches fall back to the default-branch baseline, and direnv
# auto-allow is limited to trusted base branches because .envrc can source
# additional files that direnv does not validate.
#
# TOCTOU between hash-check and trust is acceptable for local dev use.
trust_dev_tools() {
  local worktree_path="$1"
  local base_ref="$2"
  local allow_direnv_auto="$3"
  local trusted=0
  local skipped_messages=()
  local manual_commands=()

  # mise: trust the specific config file if present and unchanged
  if command -v mise &>/dev/null; then
    for f in .mise.toml mise.toml .tool-versions; do
      if [[ -f "$worktree_path/$f" ]]; then
        if _config_unchanged "$f" "$base_ref" "$worktree_path"; then
          if (cd "$worktree_path" && mise trust "$f" --quiet); then
            trusted=$((trusted + 1))
          else
            echo -e "  ${YELLOW}Warning: 'mise trust $f' failed -- run manually in $worktree_path${NC}"
          fi
        else
          skipped_messages+=("mise trust $f (config differs from $base_ref)")
          manual_commands+=("mise trust $f")
        fi
        break
      fi
    done
  fi

  # direnv: allow .envrc
  if command -v direnv &>/dev/null; then
    if [[ -f "$worktree_path/.envrc" ]]; then
      if [[ "$allow_direnv_auto" != "true" ]]; then
        skipped_messages+=("direnv allow (.envrc auto-allow is disabled for non-trusted base branches)")
        manual_commands+=("direnv allow")
      elif _config_unchanged ".envrc" "$base_ref" "$worktree_path"; then
        if (cd "$worktree_path" && direnv allow); then
          trusted=$((trusted + 1))
        else
          echo -e "  ${YELLOW}Warning: 'direnv allow' failed -- run manually in $worktree_path${NC}"
        fi
      else
        skipped_messages+=("direnv allow (.envrc differs from $base_ref)")
        manual_commands+=("direnv allow")
      fi
    fi
  fi

  if [[ $trusted -gt 0 ]]; then
    echo -e "  ${GREEN}✓ Trusted $trusted dev tool config(s)${NC}"
  fi

  if [[ ${#skipped_messages[@]} -gt 0 ]]; then
    echo -e "  ${YELLOW}Skipped auto-trust for config(s) requiring manual review:${NC}"
    for item in "${skipped_messages[@]}"; do
      echo -e "    - $item"
    done
    if [[ ${#manual_commands[@]} -gt 0 ]]; then
      local joined
      joined=$(printf ' && %s' "${manual_commands[@]}")
      echo -e "  ${BLUE}Review the diff, then run manually: cd $worktree_path${joined}${NC}"
    fi
  fi
}

# Check if a config file is unchanged from the base branch.
# Returns 0 (true) if the file is identical to the base branch version.
# Returns 1 (false) if the file was added or modified by this branch.
#
# Note: rev-parse returns the stored blob hash; hash-object on a path applies
# gitattributes filters. A mismatch causes a false negative (trust skipped),
# which is the safe direction.
_config_unchanged() {
  local file="$1"
  local base_ref="$2"
  local worktree_path="$3"

  # Reject symlinks -- trust only regular files with verifiable content
  [[ -L "$worktree_path/$file" ]] && return 1

  # Get the blob hash directly from git's object database via rev-parse
  local base_hash
  base_hash=$(git rev-parse "$base_ref:$file" 2>/dev/null) || return 1

  local worktree_hash
  worktree_hash=$(git hash-object "$worktree_path/$file") || return 1

  [[ "$base_hash" == "$worktree_hash" ]]
}

# Create a new worktree
create_worktree() {
  local branch_name="$1"
  local from_branch="${2:-main}"

  if [[ -z "$branch_name" ]]; then
    echo -e "${RED}Error: Branch name required${NC}"
    exit 1
  fi

  local worktree_path="$WORKTREE_DIR/$branch_name"

  # Check if worktree already exists
  if [[ -d "$worktree_path" ]]; then
    echo -e "${YELLOW}Worktree already exists at: $worktree_path${NC}"
    echo -e "Switch to it instead? (y/n)"
    read -r response
    if [[ "$response" == "y" ]]; then
      switch_worktree "$branch_name"
    fi
    return
  fi

  echo -e "${BLUE}Creating worktree: $branch_name${NC}"
  echo "  From: $from_branch"
  echo "  Path: $worktree_path"

  # Update main branch
  echo -e "${BLUE}Updating $from_branch...${NC}"
  git checkout "$from_branch"
  git pull origin "$from_branch" || true

  # Create worktree
  mkdir -p "$WORKTREE_DIR"
  ensure_gitignore

  echo -e "${BLUE}Creating worktree...${NC}"
  git worktree add -b "$branch_name" "$worktree_path" "$from_branch"

  # Copy environment files
  copy_env_files "$worktree_path"

  # Trust dev tool configs (mise, direnv) so hooks and scripts work immediately.
  # Long-lived integration branches can use themselves as the trust baseline,
  # while review/PR branches fall back to the default branch and require manual
  # direnv approval.
  local default_branch
  default_branch=$(get_default_branch)
  local trust_branch="$default_branch"
  local allow_direnv_auto="false"
  if is_trusted_base_branch "$from_branch" "$default_branch"; then
    trust_branch="$from_branch"
    allow_direnv_auto="true"
  fi

  if ! git fetch origin "$trust_branch" --quiet; then
    echo -e "  ${YELLOW}Warning: could not fetch origin/$trust_branch -- trust check may use stale data${NC}"
  fi
  # Skip trust entirely if the baseline ref doesn't exist locally.
  if git rev-parse --verify "origin/$trust_branch" &>/dev/null; then
    trust_dev_tools "$worktree_path" "origin/$trust_branch" "$allow_direnv_auto"
  else
    echo -e "  ${YELLOW}Skipping dev tool trust -- origin/$trust_branch not found locally${NC}"
  fi

  echo -e "${GREEN}✓ Worktree created successfully!${NC}"
  echo ""
  echo "To switch to this worktree:"
  echo -e "${BLUE}cd $worktree_path${NC}"
  echo ""
}

# List all worktrees
list_worktrees() {
  echo -e "${BLUE}Available worktrees:${NC}"
  echo ""

  if [[ ! -d "$WORKTREE_DIR" ]]; then
    echo -e "${YELLOW}No worktrees found${NC}"
    return
  fi

  local count=0
  for worktree_path in "$WORKTREE_DIR"/*; do
    if [[ -d "$worktree_path" && -e "$worktree_path/.git" ]]; then
      count=$((count + 1))
      local worktree_name=$(basename "$worktree_path")
      local branch=$(git -C "$worktree_path" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

      if [[ "$PWD" == "$worktree_path" ]]; then
        echo -e "${GREEN}✓ $worktree_name${NC} (current) → branch: $branch"
      else
        echo -e "  $worktree_name → branch: $branch"
      fi
    fi
  done

  if [[ $count -eq 0 ]]; then
    echo -e "${YELLOW}No worktrees found${NC}"
  else
    echo ""
    echo -e "${BLUE}Total: $count worktree(s)${NC}"
  fi

  echo ""
  echo -e "${BLUE}Main repository:${NC}"
  local main_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  echo "  Branch: $main_branch"
  echo "  Path: $GIT_ROOT"
}

# Switch to a worktree
switch_worktree() {
  local worktree_name="$1"

  if [[ -z "$worktree_name" ]]; then
    list_worktrees
    echo -e "${BLUE}Switch to which worktree? (enter name)${NC}"
    read -r worktree_name
  fi

  local worktree_path="$WORKTREE_DIR/$worktree_name"

  if [[ ! -d "$worktree_path" ]]; then
    echo -e "${RED}Error: Worktree not found: $worktree_name${NC}"
    echo ""
    list_worktrees
    exit 1
  fi

  echo -e "${GREEN}Switching to worktree: $worktree_name${NC}"
  cd "$worktree_path"
  echo -e "${BLUE}Now in: $(pwd)${NC}"
}

# Copy env files to an existing worktree (or current directory if in a worktree)
copy_env_to_worktree() {
  local worktree_name="$1"
  local worktree_path

  if [[ -z "$worktree_name" ]]; then
    # Check if we're currently in a worktree
    local current_dir=$(pwd)
    if [[ "$current_dir" == "$WORKTREE_DIR"/* ]]; then
      worktree_path="$current_dir"
      worktree_name=$(basename "$worktree_path")
      echo -e "${BLUE}Detected current worktree: $worktree_name${NC}"
    else
      echo -e "${YELLOW}Usage: worktree-manager.sh copy-env [worktree-name]${NC}"
      echo "Or run from within a worktree to copy to current directory"
      list_worktrees
      return 1
    fi
  else
    worktree_path="$WORKTREE_DIR/$worktree_name"

    if [[ ! -d "$worktree_path" ]]; then
      echo -e "${RED}Error: Worktree not found: $worktree_name${NC}"
      list_worktrees
      return 1
    fi
  fi

  copy_env_files "$worktree_path"
  echo ""
}

# Clean up completed worktrees
cleanup_worktrees() {
  if [[ ! -d "$WORKTREE_DIR" ]]; then
    echo -e "${YELLOW}No worktrees to clean up${NC}"
    return
  fi

  echo -e "${BLUE}Checking for completed worktrees...${NC}"
  echo ""

  local found=0
  local to_remove=()

  for worktree_path in "$WORKTREE_DIR"/*; do
    if [[ -d "$worktree_path" && -e "$worktree_path/.git" ]]; then
      local worktree_name=$(basename "$worktree_path")

      # Skip if current worktree
      if [[ "$PWD" == "$worktree_path" ]]; then
        echo -e "${YELLOW}(skip) $worktree_name - currently active${NC}"
        continue
      fi

      found=$((found + 1))
      to_remove+=("$worktree_path")
      echo -e "${YELLOW}• $worktree_name${NC}"
    fi
  done

  if [[ $found -eq 0 ]]; then
    echo -e "${GREEN}No inactive worktrees to clean up${NC}"
    return
  fi

  echo ""
  echo -e "Remove $found worktree(s)? (y/n)"
  read -r response

  if [[ "$response" != "y" ]]; then
    echo -e "${YELLOW}Cleanup cancelled${NC}"
    return
  fi

  echo -e "${BLUE}Cleaning up worktrees...${NC}"
  for worktree_path in "${to_remove[@]}"; do
    local worktree_name=$(basename "$worktree_path")
    git worktree remove "$worktree_path" --force 2>/dev/null || true
    echo -e "${GREEN}✓ Removed: $worktree_name${NC}"
  done

  # Clean up empty directory if nothing left
  if [[ -z "$(ls -A "$WORKTREE_DIR" 2>/dev/null)" ]]; then
    rmdir "$WORKTREE_DIR" 2>/dev/null || true
  fi

  echo -e "${GREEN}Cleanup complete!${NC}"
}

# Main command handler
main() {
  local command="${1:-list}"

  case "$command" in
    create)
      create_worktree "$2" "$3"
      ;;
    list|ls)
      list_worktrees
      ;;
    switch|go)
      switch_worktree "$2"
      ;;
    copy-env|env)
      copy_env_to_worktree "$2"
      ;;
    cleanup|clean)
      cleanup_worktrees
      ;;
    help)
      show_help
      ;;
    *)
      echo -e "${RED}Unknown command: $command${NC}"
      echo ""
      show_help
      exit 1
      ;;
  esac
}

show_help() {
  cat << EOF
Git Worktree Manager

Usage: worktree-manager.sh <command> [options]

Commands:
  create <branch-name> [from-branch]  Create new worktree (copies .env files automatically)
                                      (from-branch defaults to main)
  list | ls                           List all worktrees
  switch | go [name]                  Switch to worktree
  copy-env | env [name]               Copy .env files from main repo to worktree
                                      (if name omitted, uses current worktree)
  cleanup | clean                     Clean up inactive worktrees
  help                                Show this help message

Environment Files:
  - Automatically copies .env, .env.local, .env.test, etc. on create
  - Skips .env.example (should be in git)
  - Creates .backup files if destination already exists
  - Use 'copy-env' to refresh env files after main repo changes

Dev Tool Trust:
  - Trusts mise config (.mise.toml, mise.toml, .tool-versions) and direnv (.envrc)
  - Uses trusted base branches directly (main, develop, dev, trunk, staging, release/*)
  - Other branches fall back to the default branch as the trust baseline
  - direnv auto-allow is skipped on non-trusted base branches; review manually first
  - Modified configs are flagged for manual review
  - Only runs if the tool is installed and config exists
  - Prevents hooks/scripts from hanging on interactive trust prompts

Examples:
  worktree-manager.sh create feature-login
  worktree-manager.sh create feature-auth develop
  worktree-manager.sh switch feature-login
  worktree-manager.sh copy-env feature-login
  worktree-manager.sh copy-env                   # copies to current worktree
  worktree-manager.sh cleanup
  worktree-manager.sh list

EOF
}

# Run
main "$@"
