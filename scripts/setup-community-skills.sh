#!/usr/bin/env bash
# Copy xai-search and search-x from the openclaw/skills archive into your
# managed skills directory so OpenClaw can load them (Twitter/X AI monitoring).
# Usage: ./scripts/setup-community-skills.sh
# Override target: OPENCLAW_SKILLS_DIR=/path/to/skills ./scripts/setup-community-skills.sh
# Or set OPENCLAW_CONFIG_DIR so the script uses $OPENCLAW_CONFIG_DIR/skills.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ARCHIVE_URL="https://github.com/openclaw/skills.git"
CLONE_DIR="${CLONE_DIR:-$ROOT_DIR/tmp/openclaw-skills}"
# Archive layout is skills/<owner>/<skill-name>/; we copy to TARGET_DIR/<dest-name>.
# Format: "owner/skill-name:dest-name" (dest-name defaults to skill-name if omitted).
SKILLS_TO_COPY=(
  "mvanhorn/xai:xai"
  "mvanhorn/search-x:search-x"
)

if [[ -n "${OPENCLAW_SKILLS_DIR:-}" ]]; then
  TARGET_DIR="${OPENCLAW_SKILLS_DIR}"
elif [[ -n "${OPENCLAW_CONFIG_DIR:-}" ]]; then
  TARGET_DIR="${OPENCLAW_CONFIG_DIR}/skills"
else
  TARGET_DIR="${HOME}/.openclaw/skills"
fi

mkdir -p "$TARGET_DIR"
mkdir -p "$(dirname "$CLONE_DIR")"

if [[ ! -d "$CLONE_DIR/.git" ]]; then
  echo "Cloning openclaw/skills into $CLONE_DIR ..."
  git clone --depth 1 "$ARCHIVE_URL" "$CLONE_DIR"
else
  echo "Updating existing clone at $CLONE_DIR ..."
  (cd "$CLONE_DIR" && git fetch --depth 1 origin main && git checkout main)
fi

SRC_SKILLS="$CLONE_DIR/skills"
for entry in "${SKILLS_TO_COPY[@]}"; do
  if [[ "$entry" == *:* ]]; then
    src_path="${entry%%:*}"
    dest_name="${entry##*:}"
  else
    src_path="$entry"
    dest_name="${entry##*/}"
  fi
  if [[ ! -d "$SRC_SKILLS/$src_path" ]]; then
    echo "Skipping $src_path (not found in archive)."
    continue
  fi
  dest="$TARGET_DIR/$dest_name"
  echo "Copying $src_path to $dest ..."
  rm -rf "$dest"
  cp -R "$SRC_SKILLS/$src_path" "$dest"
  if [[ -f "$dest/package.json" ]]; then
    echo "Running npm install in $dest ..."
    (cd "$dest" && npm install --omit=dev)
  fi
done

echo "Done. Skills are in $TARGET_DIR. Restart the gateway or start a new session to load them."
