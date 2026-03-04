#!/usr/bin/env bash
# 下载并安装岚叔 (cclank) lanshu-waytovideo 仓库中的全部 Skill。
# 当前该仓库仅包含一个 Skill：jianying-video-gen（剪映 Seedance 2.0 AI 视频生成）。
#
# 用法: ./scripts/setup-lanshu-waytovideo-skills.sh
# 安装到仓库 skills 目录（开发用）: TARGET_DIR="$(pwd)/skills" ./scripts/setup-lanshu-waytovideo-skills.sh
# 安装到 OpenClaw 配置目录: OPENCLAW_SKILLS_DIR=~/.openclaw/skills ./scripts/setup-lanshu-waytovideo-skills.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_URL="https://github.com/cclank/lanshu-waytovideo.git"
CLONE_DIR="${CLONE_DIR:-$ROOT_DIR/.tmp-lanshu-waytovideo}"

if [[ -n "${OPENCLAW_SKILLS_DIR:-}" ]]; then
  TARGET_DIR="${OPENCLAW_SKILLS_DIR}"
elif [[ -n "${TARGET_DIR:-}" ]]; then
  TARGET_DIR="${TARGET_DIR}"
elif [[ -n "${OPENCLAW_CONFIG_DIR:-}" ]]; then
  TARGET_DIR="${OPENCLAW_CONFIG_DIR}/skills"
else
  TARGET_DIR="${ROOT_DIR}/skills"
fi

mkdir -p "$TARGET_DIR"
mkdir -p "$(dirname "$CLONE_DIR")"

if [[ ! -d "$CLONE_DIR/.git" ]]; then
  echo "Cloning lanshu-waytovideo into $CLONE_DIR ..."
  git clone --depth 1 "$REPO_URL" "$CLONE_DIR"
else
  echo "Updating existing clone at $CLONE_DIR ..."
  (cd "$CLONE_DIR" && git fetch --depth 1 origin main && git checkout main)
fi

# 当前仓库内所有 Skill 子目录（仅 jianying-video-gen）
for skill_name in jianying-video-gen; do
  src="$CLONE_DIR/$skill_name"
  if [[ ! -d "$src" ]]; then
    echo "Skipping $skill_name (not found in repo)."
    continue
  fi
  dest="$TARGET_DIR/$skill_name"
  echo "Copying $skill_name to $dest ..."
  rm -rf "$dest"
  cp -R "$src" "$dest"
  if [[ -f "$dest/package.json" ]]; then
    echo "Running npm install in $dest ..."
    (cd "$dest" && npm install --omit=dev --ignore-scripts 2>/dev/null) || true
  fi
done

echo "Done. Lanshu-waytovideo skills are in $TARGET_DIR. Restart the gateway or refresh skills to load them."
