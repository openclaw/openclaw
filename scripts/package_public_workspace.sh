#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPORT_SCRIPT="$ROOT_DIR/scripts/export_public_workspace.sh"
ARCHIVE_PATH="$ROOT_DIR/dist/public-workspace-template.tar.gz"

mkdir -p "$ROOT_DIR/dist"

if [[ -d "$ROOT_DIR/public_templates/workspace" && -f "$EXPORT_SCRIPT" ]]; then
  "$EXPORT_SCRIPT" >/dev/null
  tar -C "$ROOT_DIR/dist" -czf "$ARCHIVE_PATH" public-workspace-template
else
  TMP_DIR="$(mktemp -d /tmp/public-workspace-template-package-XXXXXX)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  mkdir -p "$TMP_DIR/public-workspace-template"
  tar -C "$ROOT_DIR" --exclude='./dist' -cf - . | tar -C "$TMP_DIR/public-workspace-template" -xf -
  tar -C "$TMP_DIR" -czf "$ARCHIVE_PATH" public-workspace-template
fi

echo "Packaged public workspace template at: $ARCHIVE_PATH"
