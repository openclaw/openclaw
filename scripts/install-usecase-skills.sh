#!/usr/bin/env bash
# 从 Awesome OpenClaw 用例集 (EvoLinkAI/awesome-openclaw-usecases-moltbook) 中
# 解析「Skills You Need」里的 ClawHub 链接，去重后依次执行 clawhub install。
#
# 用法:
#   ./scripts/install-usecase-skills.sh              # 安装到默认 workdir（当前目录或 OPENCLAW 工作区）
#   OPENCLAW_SKILLS_DIR=/path/to/skills ./scripts/install-usecase-skills.sh
#   DRY_RUN=1 ./scripts/install-usecase-skills.sh   # 只打印要安装的 slug，不执行
#
# 依赖: 已安装 clawhub（npm i -g clawhub 或 npx clawhub@latest）

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
USECASES_REPO="${USECASES_REPO:-https://github.com/EvoLinkAI/awesome-openclaw-usecases-moltbook.git}"
CLONE_DIR="${CLONE_DIR:-$ROOT_DIR/.tmp-awesome-usecases}"
DRY_RUN="${DRY_RUN:-0}"

if [[ -n "${OPENCLAW_SKILLS_DIR:-}" ]]; then
  SKILLS_DIR="${OPENCLAW_SKILLS_DIR}"
elif [[ -n "${OPENCLAW_CONFIG_DIR:-}" ]]; then
  SKILLS_DIR="${OPENCLAW_CONFIG_DIR}/skills"
else
  SKILLS_DIR="${ROOT_DIR}/skills"
fi

mkdir -p "$(dirname "$CLONE_DIR")"

if [[ ! -d "$CLONE_DIR/.git" ]]; then
  echo "Cloning awesome-openclaw-usecases-moltbook into $CLONE_DIR ..."
  git clone --depth 1 "$USECASES_REPO" "$CLONE_DIR"
else
  echo "Updating existing clone at $CLONE_DIR ..."
  (cd "$CLONE_DIR" && git fetch --depth 1 origin main && git checkout main)
fi

USECASES_DIR="$CLONE_DIR/usecases"
if [[ ! -d "$USECASES_DIR" ]]; then
  echo "Error: usecases directory not found in $CLONE_DIR" >&2
  exit 1
fi

# 从 .md 中提取 clawhub.ai/skills/xxx 或 clawhub.com/skills/xxx 的 slug，去重排序（兼容 macOS sed）
SLUGS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && SLUGS+=("$line")
done < <(grep -RhoE 'clawhub\.(ai|com)/skills/[a-zA-Z0-9_.-]+' "$USECASES_DIR" 2>/dev/null | sed 's|.*/skills/||' | sort -u)

if [[ ${#SLUGS[@]} -eq 0 ]]; then
  echo "No ClawHub skill slugs found in usecases."
  exit 0
fi

echo "Found ${#SLUGS[@]} unique ClawHub skill(s):"
printf '  - %s\n' "${SLUGS[@]}"
echo "Target skills dir: $SKILLS_DIR"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY_RUN=1: skip install. Run without DRY_RUN to install."
  exit 0
fi

if ! command -v clawhub &>/dev/null && ! npx clawhub --help &>/dev/null 2>&1; then
  echo "Install ClawHub first: npm i -g clawhub  or  pnpm add -g clawhub" >&2
  echo "Then run this script again." >&2
  exit 1
fi

mkdir -p "$SKILLS_DIR"
# ClawHub 安装到 <workdir>/skills；令 workdir 为 SKILLS_DIR 的父目录
CLAWHUB_WORKDIR="$(dirname "$SKILLS_DIR")"
export CLAWHUB_WORKDIR

for slug in "${SLUGS[@]}"; do
  echo "Installing $slug ..."
  if (cd "$CLAWHUB_WORKDIR" && npx clawhub@latest install "$slug" 2>/dev/null); then
    echo "  OK: $slug"
  else
    # 部分 slug 可能不存在或需登录，继续下一个
    echo "  Skip or failed: $slug"
  fi
done

echo "Done. Skills are in $SKILLS_DIR. Restart the gateway or refresh skills to load them."
