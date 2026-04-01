#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 <target-repo-dir> [target-subdir]" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPORT_SCRIPT="$ROOT_DIR/scripts/export_public_workspace.sh"
TARGET_REPO_DIR="$1"
TARGET_SUBDIR="${2:-templates/workspace}"
TARGET_DIR="$TARGET_REPO_DIR/$TARGET_SUBDIR"

if [[ ! -d "$TARGET_REPO_DIR" ]]; then
  echo "Target repo dir does not exist: $TARGET_REPO_DIR" >&2
  exit 1
fi

if [[ -d "$ROOT_DIR/public_templates/workspace" && -f "$EXPORT_SCRIPT" ]]; then
  "$EXPORT_SCRIPT" >/dev/null
  SOURCE_DIR="$ROOT_DIR/dist/public-workspace-template"
else
  SOURCE_DIR="$ROOT_DIR"
fi

rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
tar -C "$SOURCE_DIR" --exclude='./dist' -cf - . | tar -C "$TARGET_DIR" -xf -

echo "Installed public workspace template to: $TARGET_DIR"
