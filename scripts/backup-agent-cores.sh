#!/usr/bin/env bash
# ==============================================================================
# backup-agent-cores.sh
#
# 備份 ~/.openclaw/agents/ 中的 AI agent 核心檔案到 agent-backups/ 目錄。
# 可選擇性地 commit 並推送到 GitHub，以防專案被重置後可還原。
#
# 用法:
#   ./scripts/backup-agent-cores.sh [OPTIONS]
#
# 選項:
#   --push              備份後 commit 並推送到目前 git 分支
#   --agent <agentId>   只備份指定 agent（預設：備份所有 agents）
#   --days <N>          備份最近 N 天的每日記憶（預設：30）
#   --dry-run           只顯示將執行的動作，不實際複製
#   -h, --help          顯示說明
#
# 範例:
#   ./scripts/backup-agent-cores.sh --push
#   ./scripts/backup-agent-cores.sh --agent abc123 --push
#   ./scripts/backup-agent-cores.sh --dry-run
# ==============================================================================
set -euo pipefail

# ── 設定 ────────────────────────────────────────────────────────────────────
OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
AGENTS_DIR="$OPENCLAW_DIR/agents"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="$REPO_ROOT/agent-backups"
TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
LOG_PREFIX="[backup-agent-cores]"

# 要備份的核心 markdown 檔案（相對於 agent 根目錄）
CORE_FILES=(
  "SOUL.md"
  "SOUL.dev.md"
  "MEMORY.md"
  "IDENTITY.md"
  "IDENTITY.dev.md"
  "TOOLS.md"
  "TOOLS.dev.md"
  "AGENTS.md"
  "AGENTS.dev.md"
  "USER.md"
  "USER.dev.md"
  "BOOT.md"
  "BOOTSTRAP.md"
  "HEARTBEAT.md"
  "GROWTH_LOG.md"
  "WEEKLY_REVIEW.md"
)

# ── 引數解析 ────────────────────────────────────────────────────────────────
PUSH=false
AGENT_FILTER=""
MEMORY_DAYS=30
DRY_RUN=false
FILES_COPIED=0
FILES_SKIPPED=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --push)        PUSH=true; shift ;;
    --agent)       AGENT_FILTER="$2"; shift 2 ;;
    --days)        MEMORY_DAYS="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=true; shift ;;
    -h|--help)
      sed -n '/^# ==/,/^# ==/p' "$0" | sed 's/^# \{0,2\}//'
      exit 0
      ;;
    *) echo "$LOG_PREFIX 未知選項: $1" >&2; exit 1 ;;
  esac
done

# ── 輔助函式 ────────────────────────────────────────────────────────────────
log()  { echo "$LOG_PREFIX $*"; }
warn() { echo "$LOG_PREFIX ⚠️  $*" >&2; }

# 複製單一檔案（支援 dry-run）
copy_file() {
  local src="$1"
  local dst="$2"

  if [[ ! -f "$src" ]]; then
    return 0  # 來源不存在，靜默跳過
  fi

  local dst_dir
  dst_dir="$(dirname "$dst")"

  if $DRY_RUN; then
    echo "  [dry-run] cp  $src"
    echo "             → $dst"
    (( FILES_COPIED++ )) || true
    return 0
  fi

  mkdir -p "$dst_dir"

  # 只有內容有變動才更新（避免不必要的 git diff）
  if [[ -f "$dst" ]] && cmp -s "$src" "$dst"; then
    (( FILES_SKIPPED++ )) || true
    return 0
  fi

  cp "$src" "$dst"
  (( FILES_COPIED++ )) || true
}

# 遞迴複製目錄中的 .md 和 .yaml 檔案
copy_dir_md() {
  local src_dir="$1"
  local dst_dir="$2"

  if [[ ! -d "$src_dir" ]]; then
    return 0
  fi

  while IFS= read -r -d '' src; do
    local rel="${src#"$src_dir/"}"
    copy_file "$src" "$dst_dir/$rel"
  done < <(find "$src_dir" \( -name "*.md" -o -name "*.yaml" -o -name "*.yml" \) -print0 2>/dev/null)
}

# ── 前置檢查 ─────────────────────────────────────────────────────────────────
if [[ ! -d "$AGENTS_DIR" ]]; then
  warn "找不到 agents 目錄：$AGENTS_DIR"
  warn "請先安裝並執行 openclaw（確認 gateway 至少啟動一次）。"
  warn "若 OPENCLAW_DIR 不是 ~/.openclaw，請設定環境變數後重試："
  warn "  OPENCLAW_DIR=/path/to/openclaw ./scripts/backup-agent-cores.sh"
  exit 1
fi

log "開始備份 agent 核心檔案..."
log "來源目錄: $AGENTS_DIR"
log "備份目錄: $BACKUP_DIR"
$DRY_RUN && log "（dry-run 模式：不會實際複製任何檔案）"
echo ""

# ── Step 1: 備份每個 agent 的核心檔案 ───────────────────────────────────────
# 列出所有 agent 目錄
AGENT_DIRS=()
if [[ -n "$AGENT_FILTER" ]]; then
  if [[ -d "$AGENTS_DIR/$AGENT_FILTER" ]]; then
    AGENT_DIRS=("$AGENTS_DIR/$AGENT_FILTER")
  else
    warn "找不到 agent: $AGENT_FILTER（路徑：$AGENTS_DIR/$AGENT_FILTER）"
    exit 1
  fi
else
  while IFS= read -r -d '' dir; do
    AGENT_DIRS+=("$dir")
  done < <(find "$AGENTS_DIR" -maxdepth 1 -mindepth 1 -type d -print0 2>/dev/null)
fi

if [[ ${#AGENT_DIRS[@]} -eq 0 ]]; then
  warn "在 $AGENTS_DIR 中找不到任何 agent 目錄。"
  exit 0
fi

for agent_dir in "${AGENT_DIRS[@]}"; do
  agent_id="$(basename "$agent_dir")"
  dst_agent_dir="$BACKUP_DIR/$agent_id"

  log "▸ Agent: $agent_id"

  # 核心 markdown 檔案
  for fname in "${CORE_FILES[@]}"; do
    copy_file "$agent_dir/$fname" "$dst_agent_dir/$fname"
  done

  # 每日記憶筆記（memory/ 子目錄，最近 N 天）
  memory_src="$agent_dir/memory"
  if [[ -d "$memory_src" ]]; then
    cutoff_date=$(date -d "$MEMORY_DAYS days ago" +%Y-%m-%d 2>/dev/null \
                  || date -v-"${MEMORY_DAYS}"d +%Y-%m-%d 2>/dev/null \
                  || echo "0000-00-00")

    while IFS= read -r -d '' note; do
      note_name="$(basename "$note" .md)"
      # 只備份 YYYY-MM-DD.md 格式的檔案，且在截止日期之後
      if [[ "$note_name" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] \
         && [[ "$note_name" > "$cutoff_date" || "$note_name" == "$cutoff_date" ]]; then
        copy_file "$note" "$dst_agent_dir/memory/$(basename "$note")"
      fi
    done < <(find "$memory_src" -name "*.md" -print0 2>/dev/null)
  fi

  # 知識銀行（bank/ 子目錄：world, experience, opinions, entities）
  copy_dir_md "$agent_dir/bank" "$dst_agent_dir/bank"
done

echo ""

# ── Step 2: 備份 repo 中的 skills 快照 ──────────────────────────────────────
log "▸ 備份 .agents/skills/ 快照..."
copy_dir_md "$REPO_ROOT/.agents/skills" "$BACKUP_DIR/skills-snapshot"

log "▸ 備份 .pi/prompts/ 快照..."
copy_dir_md "$REPO_ROOT/.pi/prompts" "$BACKUP_DIR/pi-prompts-snapshot"

echo ""
log "✅ 備份完成"
log "   已複製: $FILES_COPIED 個檔案"
log "   未變動: $FILES_SKIPPED 個檔案（略過）"
echo ""

# ── Step 3: 寫入備份元資料 ─────────────────────────────────────────────────
if ! $DRY_RUN; then
  cat > "$BACKUP_DIR/.last-backup" <<EOF
timestamp=$TIMESTAMP
agents=${#AGENT_DIRS[@]}
files_copied=$FILES_COPIED
host=$(hostname)
EOF
fi

# ── Step 4: Git commit + push（可選）─────────────────────────────────────────
if $PUSH && ! $DRY_RUN; then
  echo ""
  log "準備 git commit..."

  cd "$REPO_ROOT"

  # 只 stage agent-backups/ 目錄（不動其他未暫存的變更）
  git add agent-backups/

  if git diff --cached --quiet; then
    log "沒有新的變更可 commit（備份已是最新狀態）。"
  else
    CHANGED=$(git diff --cached --name-only | wc -l | tr -d ' ')
    git commit -m "$(cat <<EOF
chore(backup): agent core files snapshot $TIMESTAMP

Backed up core files for ${#AGENT_DIRS[@]} agent(s):
$(for d in "${AGENT_DIRS[@]}"; do echo "  - $(basename "$d")"; done)

Files updated: $CHANGED
Source host: $(hostname)

https://claude.ai/code/session_01USg9NmxVF4tcQnBdCBYgUt
EOF
)"
    log "📦 commit 成功。"

    CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
    log "推送到 origin/$CURRENT_BRANCH ..."
    git push -u origin "$CURRENT_BRANCH"
    log "🚀 推送完成。"
  fi
fi

if $DRY_RUN; then
  echo ""
  log "Dry-run 完成。執行以下指令進行真實備份："
  log "  ./scripts/backup-agent-cores.sh [--push]"
fi
