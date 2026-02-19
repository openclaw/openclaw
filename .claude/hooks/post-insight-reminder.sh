#!/usr/bin/env bash
# PostToolUse hook: remind to create an insight after editing source files.
# Reads tool_input JSON from stdin, checks if the edited file is in src/.
# Returns a JSON object with systemMessage if applicable.

set -euo pipefail

INPUT=$(cat)

# Extract file_path from the tool input JSON
FILE_PATH=$(echo "$INPUT" | sed -n 's/.*"file_path"\s*:\s*"\([^"]*\)".*/\1/p' | head -1)

# Only trigger for files under src/ (not docs, tests, config, etc.)
if [[ -z "$FILE_PATH" ]]; then
  echo '{}'
  exit 0
fi

if [[ "$FILE_PATH" == */src/* ]]; then
  cat <<'EOF'
{"systemMessage":"If this was a bug fix or a resolution of a non-obvious problem, consider documenting it as an insight in docs/ccli-max-cloudru-fm/insights/ using the /myinsights command or by creating a YYYY-MM-DD-<slug>.md file with the standard template (symptoms, root cause, solution, key files)."}
EOF
else
  echo '{}'
fi
