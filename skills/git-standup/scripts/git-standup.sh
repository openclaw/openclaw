#!/usr/bin/env bash
# git-standup.sh — Summarize recent git activity across repos
set -euo pipefail

DAYS=1
AUTHOR=""
SHOW_BRANCHES=false
SHOW_PRS=false
REPOS=()

usage() {
  echo "Usage: git-standup.sh [-d DAYS] [-a AUTHOR] [-b] [-p] [REPO_PATHS...]"
  echo "  -d DAYS    Look back N days (default: 1)"
  echo "  -a AUTHOR  Filter by author (default: git user.name)"
  echo "  -b         Include branch summary"
  echo "  -p         Include open PRs (requires gh CLI)"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d) DAYS="$2"; shift 2 ;;
    -a) AUTHOR="$2"; shift 2 ;;
    -b) SHOW_BRANCHES=true; shift ;;
    -p) SHOW_PRS=true; shift ;;
    -h|--help) usage ;;
    -*) echo "Unknown option: $1"; usage ;;
    *) REPOS+=("$1"); shift ;;
  esac
done

# Default to current directory
if [[ ${#REPOS[@]} -eq 0 ]]; then
  REPOS=(".")
fi

SINCE_DATE=$(date -d "-${DAYS} days" '+%Y-%m-%d' 2>/dev/null || date -v "-${DAYS}d" '+%Y-%m-%d' 2>/dev/null)

echo "📋 Git Standup — Last ${DAYS} day(s) (since ${SINCE_DATE})"
echo ""

for repo_path in "${REPOS[@]}"; do
  # Resolve to absolute path
  repo_path=$(cd "$repo_path" 2>/dev/null && pwd || echo "$repo_path")

  if [[ ! -d "$repo_path/.git" && ! -f "$repo_path/.git" ]]; then
    echo "⚠️  Not a git repo: $repo_path"
    echo ""
    continue
  fi

  repo_name=$(basename "$repo_path")
  echo "## ${repo_name}"
  echo ""

  # Resolve author
  if [[ -z "$AUTHOR" ]]; then
    AUTHOR=$(git -C "$repo_path" config user.name 2>/dev/null || echo "")
  fi

  # Commits
  AUTHOR_FLAG=""
  if [[ -n "$AUTHOR" ]]; then
    AUTHOR_FLAG="--author=${AUTHOR}"
  fi

  commits=$(git -C "$repo_path" log \
    --all \
    --since="${SINCE_DATE}" \
    ${AUTHOR_FLAG:+"$AUTHOR_FLAG"} \
    --pretty=format:"- %h %s (%ar)" \
    --no-merges \
    2>/dev/null || echo "")

  if [[ -n "$commits" ]]; then
    commit_count=$(echo "$commits" | wc -l | tr -d ' ')
    echo "**Commits (${commit_count}):**"
    echo "$commits"
  else
    echo "**Commits:** None in the last ${DAYS} day(s)"
  fi
  echo ""

  # Branches
  if [[ "$SHOW_BRANCHES" == true ]]; then
    current=$(git -C "$repo_path" branch --show-current 2>/dev/null || echo "unknown")
    recent_branches=$(git -C "$repo_path" branch --sort=-committerdate --format='%(refname:short)' 2>/dev/null | head -5 | tr '\n' ', ' | sed 's/,$//')
    echo "**Current branch:** ${current}"
    echo "**Recent branches:** ${recent_branches}"
    echo ""
  fi

  # Open PRs (requires gh CLI)
  if [[ "$SHOW_PRS" == true ]]; then
    if command -v gh &>/dev/null; then
      prs=$(cd "$repo_path" && gh pr list --author "@me" --state open --limit 10 --json number,title,isDraft \
        --template '{{range .}}- #{{.number}} {{.title}}{{if .isDraft}} (draft){{end}}
{{end}}' 2>/dev/null || echo "")
      
      if [[ -n "$prs" ]]; then
        echo "**Open PRs:**"
        echo "$prs"
      else
        echo "**Open PRs:** None"
      fi

      # Review requests
      review_prs=$(cd "$repo_path" && gh pr list --search "review-requested:@me" --state open --limit 5 --json number,title \
        --template '{{range .}}- #{{.number}} {{.title}}
{{end}}' 2>/dev/null || echo "")

      if [[ -n "$review_prs" ]]; then
        echo "**Review requests:**"
        echo "$review_prs"
      fi
      echo ""
    else
      echo "**PRs:** gh CLI not available, skipping"
      echo ""
    fi
  fi
done
