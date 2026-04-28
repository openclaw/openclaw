#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./pending-final-delivery-2026.4.9-apply-commands.sh /absolute/path/to/openclaw-2026.4.9-source-tree
# Optional:
#   INSTALL_GLOBAL=1 RESTART_GATEWAY=1 ./pending-final-delivery-2026.4.9-apply-commands.sh /path/to/repo

TARGET_REPO="${1:-}"
PATCH_FILE="/home/mertb/.openclaw/workspace/pending-final-delivery-v2026.4.9-full.patch"
PACK_DIR="${PACK_DIR:-$TARGET_REPO/.artifacts/pack}"
INSTALL_GLOBAL="${INSTALL_GLOBAL:-0}"
RESTART_GATEWAY="${RESTART_GATEWAY:-0}"

if [[ -z "$TARGET_REPO" ]]; then
  echo "Usage: $0 /absolute/path/to/openclaw-2026.4.9-source-tree" >&2
  exit 1
fi

if [[ ! -d "$TARGET_REPO/.git" ]]; then
  echo "Target repo is not a git checkout: $TARGET_REPO" >&2
  exit 1
fi

if [[ ! -f "$PATCH_FILE" ]]; then
  echo "Patch file not found: $PATCH_FILE" >&2
  exit 1
fi

echo "== verify target repo =="
git -C "$TARGET_REPO" rev-parse --short HEAD
git -C "$TARGET_REPO" status --short

echo
echo "== check patch applies cleanly =="
git -C "$TARGET_REPO" apply --check "$PATCH_FILE"

echo
echo "== create backup branch =="
BACKUP_BRANCH="backup/pending-final-delivery-$(date +%Y%m%d-%H%M%S)"
git -C "$TARGET_REPO" switch -c "$BACKUP_BRANCH"

echo
echo "== apply patch =="
git -C "$TARGET_REPO" apply "$PATCH_FILE"

echo
echo "== run targeted tests =="
pnpm --dir "$TARGET_REPO" exec vitest run \
  src/agents/subagent-registry.persistence.test.ts \
  src/agents/subagent-registry.test.ts \
  src/agents/subagent-registry-lifecycle.test.ts \
  --reporter=dot

echo
echo "== build package contents =="
pnpm --dir "$TARGET_REPO" build
pnpm --dir "$TARGET_REPO" ui:build

echo
echo "== pack tarball =="
mkdir -p "$PACK_DIR"
pushd "$TARGET_REPO" >/dev/null
PACK_JSON=$(OPENCLAW_PREPACK_PREPARED=1 npm pack --json --pack-destination "$PACK_DIR")
popd >/dev/null
TARBALL_NAME=$(node -e 'const data = JSON.parse(process.argv[1]); console.log((Array.isArray(data) ? data[0] : data).filename)' "$PACK_JSON")
TARBALL_PATH="$PACK_DIR/$TARBALL_NAME"

echo "Packed tarball: $TARBALL_PATH"

echo
echo "== verify tarball contents =="
tar -tf "$TARBALL_PATH" | grep -q '^package/dist/index.js$'
tar -tf "$TARBALL_PATH" | grep -q '^package/dist/control-ui/index.html$'
echo "Tarball contains dist/index.js and dist/control-ui/index.html"

echo
GLOBAL_ROOT=$(npm root -g)
echo "Global npm root: $GLOBAL_ROOT"
echo "Current openclaw version: $(openclaw --version 2>/dev/null || echo unknown)"

if [[ "$INSTALL_GLOBAL" == "1" ]]; then
  echo
  echo "== install tarball globally =="
  npm install -g --force "$TARBALL_PATH"
else
  echo "Global install skipped. Set INSTALL_GLOBAL=1 to install the tarball globally."
fi

if [[ "$RESTART_GATEWAY" == "1" ]]; then
  echo
  echo "== restart gateway =="
  openclaw gateway restart
  echo
  echo "== post-restart status =="
  openclaw status
else
  echo "Gateway restart skipped. Set RESTART_GATEWAY=1 to restart automatically."
fi

echo
echo "Done. Review git diff/status in: $TARGET_REPO"
