#!/bin/sh
# install-subrepo-hooks.sh
#
# Installs post-commit hooks in MAIOSS and MAIBEAUTY repos
# that call back to MAIBOT's sync-subrepo-to-memory.ts.
#
# Usage: bash scripts/install-subrepo-hooks.sh
#        (run from MAIBOT repo root)

set -e

MAIBOT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "[install-subrepo-hooks] MAIBOT_ROOT=$MAIBOT_ROOT"

# Convert to Windows path for the hook script (Git Bash uses /c/... internally)
MAIBOT_ROOT_WIN=$(cygpath -w "$MAIBOT_ROOT" 2>/dev/null || echo "$MAIBOT_ROOT")

# --- Sub-repo definitions ---
REPOS="maioss:C:/TEST/MAIOSS maibeauty:C:/TEST/MAIBEAUTY"

for entry in $REPOS; do
  KEY="${entry%%:*}"
  REPO_PATH="${entry#*:}"
  HOOK_FILE="$REPO_PATH/.git/hooks/post-commit"

  echo ""
  echo "[${KEY}] repo: $REPO_PATH"

  if [ ! -d "$REPO_PATH/.git" ]; then
    echo "  [skip] not a git repo: $REPO_PATH"
    continue
  fi

  # The snippet we inject — guarded by unique markers
  MARKER_START="# >>> MAIBOT-SYNC-START >>>"
  MARKER_END="# <<< MAIBOT-SYNC-END <<<"

  HOOK_SNIPPET="${MARKER_START}
# Auto-sync to MAIBOT memory + Obsidian dashboards on commit
MAIBOT_DIR=\"${MAIBOT_ROOT_WIN}\"
if command -v node >/dev/null 2>&1 && [ -f \"\$MAIBOT_DIR/scripts/sync-subrepo-to-memory.ts\" ]; then
  node --import tsx \"\$MAIBOT_DIR/scripts/sync-subrepo-to-memory.ts\" ${KEY} &
fi
${MARKER_END}"

  if [ -f "$HOOK_FILE" ]; then
    # Check if already installed
    if grep -q "$MARKER_START" "$HOOK_FILE" 2>/dev/null; then
      echo "  [ok] hook already installed — updating"
      # Remove old snippet and re-append
      # Use sed to delete between markers (inclusive)
      sed -i "/${MARKER_START//\//\\/}/,/${MARKER_END//\//\\/}/d" "$HOOK_FILE"
    else
      echo "  [append] adding MAIBOT sync to existing hook"
    fi
    # Append
    printf '\n%s\n' "$HOOK_SNIPPET" >> "$HOOK_FILE"
  else
    # Create new hook file
    echo "  [create] new post-commit hook"
    printf '#!/bin/sh\n\n%s\n' "$HOOK_SNIPPET" > "$HOOK_FILE"
  fi

  chmod +x "$HOOK_FILE" 2>/dev/null || true
  echo "  [done] hook installed: $HOOK_FILE"
done

echo ""
echo "[install-subrepo-hooks] complete"
