#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_DIR="$ROOT_DIR/public_templates/workspace"
OUT_DIR="$ROOT_DIR/dist/public-workspace-template"
NOTES_FILE="$ROOT_DIR/public_templates/CONTRIBUTION_NOTES.md"
PR_DRAFT_FILE="$ROOT_DIR/public_templates/PR_DRAFT.md"
HANDOFF_FILE="$ROOT_DIR/public_templates/HANDOFF.md"
HARNESS_TOOLS_FILE="$ROOT_DIR/context/HARNESS_TOOLS.md"

PUBLIC_SCRIPT_FILES=(
  "scripts/openclaw_harness.py"
  "scripts/test_openclaw_harness.py"
  "scripts/enable_auto_session_closeout_plugin.py"
  "scripts/test_enable_auto_session_closeout_plugin.py"
  "scripts/install_public_workspace_template.sh"
  "scripts/package_public_workspace.sh"
  "scripts/nightly_dream.sh"
  "scripts/install_nightly_dream_cron.sh"
  "scripts/upsert_nightly_dream_cron.py"
  "scripts/archive_stale_weixin_queue.py"
)

if [[ ! -d "$TEMPLATE_DIR" ]]; then
  echo "Template directory not found: $TEMPLATE_DIR" >&2
  exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp -R "$TEMPLATE_DIR"/. "$OUT_DIR"/

mkdir -p "$OUT_DIR/context"
if [[ -f "$HARNESS_TOOLS_FILE" ]]; then
  cp "$HARNESS_TOOLS_FILE" "$OUT_DIR/context/HARNESS_TOOLS.md"
fi

mkdir -p "$OUT_DIR/scripts"
for rel_path in "${PUBLIC_SCRIPT_FILES[@]}"; do
  src="$ROOT_DIR/$rel_path"
  if [[ -f "$src" ]]; then
    cp "$src" "$OUT_DIR/$rel_path"
  fi
done

cat > "$OUT_DIR/README.md" <<'EOF'
# Public Workspace Template

This bundle is generated from `public_templates/workspace` plus a curated set of safe runtime scripts.

It is intended for:

- reviewing the public protocol layout
- sharing a reusable workspace starter
- preparing a contribution-safe snapshot
- bootstrapping the same public harness workflow used in this workspace

It intentionally excludes live private memory, runtime state, and personal content.

Included runtime files:

- `context/HARNESS_TOOLS.md`
- `scripts/openclaw_harness.py`
- `scripts/enable_auto_session_closeout_plugin.py`
- `scripts/install_public_workspace_template.sh`
- `scripts/package_public_workspace.sh`
- nightly dream helper scripts
- harness regression tests
EOF

if [[ -f "$NOTES_FILE" ]]; then
  cp "$NOTES_FILE" "$OUT_DIR/CONTRIBUTION_NOTES.md"
fi

if [[ -f "$PR_DRAFT_FILE" ]]; then
  cp "$PR_DRAFT_FILE" "$OUT_DIR/PR_DRAFT.md"
fi

if [[ -f "$HANDOFF_FILE" ]]; then
  cp "$HANDOFF_FILE" "$OUT_DIR/HANDOFF.md"
fi

echo "Exported public workspace template to: $OUT_DIR"
