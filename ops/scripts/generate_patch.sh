#!/usr/bin/env bash
set -euo pipefail

TASK_FILE="$1"

echo "[generate_patch] task: $TASK_FILE"

goal=$(jq -r '.goal' "$TASK_FILE")

echo "[generate_patch] collecting repository context..."

REPO_CONTEXT=$(git ls-files | head -n 50 || true)

FILE_SAMPLE=$(sed -n '1,200p' ops/scripts/task_runner.sh 2>/dev/null || true)

echo "[generate_patch] goal: $goal"

openclaw-safe agent \
  --agent dir-eng-platform-01 \
  --timeout 120 \
  --thinking off \
  --message "You are an autonomous software engineer working inside this repository.

Repository files (partial list):
$REPO_CONTEXT

Relevant code references:
$FILE_SAMPLE

Task goal:
$goal

Generate a valid unified git patch.

Rules:
- Output ONLY a valid unified git patch.
- The first line MUST start with: diff --git a/<path> b/<path>
- The patch MUST include:
    --- a/<path>
    +++ b/<path>
- Use proper hunk headers like:
    @@ -start,count +start,count @@
- Modify existing files only.
- Do NOT invent new files.
- Do NOT include explanations.
- Do NOT include markdown.
- Do NOT include code fences.
- Output must be directly usable with: git apply
- The patch MUST apply cleanly using: git apply
" \
--json \
| jq -r '.result.payloads[0].text' \
| sed -n '/^diff --git/,$p' \
| tr -d '\r' > patch.diff

echo "[generate_patch] patch written to patch.diff"
