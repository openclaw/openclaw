#!/usr/bin/env bash
set -euo pipefail

TASK_FILE="$1"

echo "[generate_patch] task: $TASK_FILE"

goal=$(jq -r '.goal' "$TASK_FILE")

# Load reviewer feedback if it exists
REVIEWER_FEEDBACK=""
if [[ -f reviewer_feedback.txt ]]; then
  REVIEWER_FEEDBACK=$(cat reviewer_feedback.txt)
  echo "[generate_patch] using reviewer feedback: $REVIEWER_FEEDBACK"
fi

echo "[generate_patch] collecting repository context..."

REPO_CONTEXT=$(git ls-files | grep -E '\.(sh|py|js|ts|json|yaml|yml)$' | head -n 200 || true)

FILE_SAMPLE=""

for f in ops/scripts/task_runner.sh ops/scripts/generate_patch.sh ops/scripts/review_patch.sh; do
  if [[ -f "$f" ]]; then
    FILE_SAMPLE="$FILE_SAMPLE

===== FILE: $f =====
$(sed -n '1,200p' "$f")"
  fi
done

FUNCTION_INDEX=$(grep -nE '^[a-zA-Z0-9_]+\(\)\s*\{' ops/scripts/*.sh 2>/dev/null || true)

echo "[generate_patch] goal: $goal"

openclaw-safe agent \
  --agent dir-eng-platform-01 \
  --timeout 120 \
  --thinking off \
  --message "You are an autonomous software engineer working inside this repository.

Repository files (partial list):
$REPO_CONTEXT

Likely files to modify should be selected from the repository list above.
Choose the most relevant file before generating the patch.
Focus on scripts in ops/scripts if the task relates to the task runner or automation.

Relevant code references:
$FILE_SAMPLE

Task goal:
$goal

Previous reviewer feedback (if any):
$REVIEWER_FEEDBACK

Before generating the patch:

1. Briefly think about which file and section must change.
2. Identify the exact lines that should be modified.
3. Then produce the final patch.

Only output the final unified git patch.
Do not output the reasoning or planning.

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
