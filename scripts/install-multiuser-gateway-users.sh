#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="${REPO_OWNER:-rylena}"
REPO_NAME="${REPO_NAME:-rylen-openclaw}"
REPO_REF="${REPO_REF:-feat/instagram-cli-channel}"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but not installed." >&2
  exit 1
fi

PKG_SPEC="github:${REPO_OWNER}/${REPO_NAME}#${REPO_REF}"
echo "Installing OpenClaw from ${PKG_SPEC} ..."
npm install -g "${PKG_SPEC}"
echo "Done. Run: openclaw gateway users list"
