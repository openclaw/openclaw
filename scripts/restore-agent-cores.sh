#!/usr/bin/env bash
# ==============================================================================
# restore-agent-cores.sh
#
# 從 agent-backups/ 還原 AI agent 核心檔案到 ~/.openclaw/agents/。
# 當專案被重置（fresh clone）或換新機器時使用。
#
# 用法:
#   ./scripts/restore-agent-cores.sh [OPTIONS]
#
# 選項:
#   --agent <agentId>   只還原指定 agent（預設：還原所有 agents）
#   --dry-run           只顯示將執行的動作，不實際複製
#   --force             覆寫目標端已存在的檔案（預設：保護既有檔案）
#   --list              列出 agent-backups/ 中所有可還原的 agents
#   -h, --help          顯示說明
#
# 範例:
#   ./scripts/restore-agent-cores.sh --list
#   ./scripts/restore-agent-cores.sh --dry-run
#   ./scripts/restore-agent-cores.sh --agent abc123
#   ./scripts/restore-agent-cores.sh --force
# ==============================================================================
set -euo pipefail

# ── 設定 ────────────────────────────────────────────────────────────────────
OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
AGENTS_DIR="$OPENCLAW_DIR/agents"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="$REPO_ROOT/agent-backups"
LOG_PREFIX="[restore-agent-cores]"

# ── 引數解析 ────────────────────────────────────────────────────────────────
AGENT_FILTER=""
DRY_RUN=false
FORCE=false
LIST_ONLY=false
FILES_RESTORED=0
FILES_SKIPPED=0
FILES_PROTECTED=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)   AGENT_FILTER="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --force)   FORCE=true; shift ;;
    --list)    LIST_ONLY=true; shift ;;
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

# ── --list 模式 ──────────────────────────────────────────────────────────────
if $LIST_ONLY; then
  if [[ ! -d "$BACKUP_DIR" ]]; then
    warn "找不到備份目錄：$BACKUP_DIR"
    exit 1
  fi

  echo ""
  echo "=== 可還原的 Agent 備份 ==="
  echo ""

  # 顯示最後備份時間
  if [[ -f "$BACKUP_DIR/.last-backup" ]]; then
    source "$BACKUP_DIR/.last-backup" 2>/dev/null || true
    echo "最後備份時間: ${timestamp:-未知}"
    echo "備份主機:     ${host:-未知}"
    echo ""
  fi

  # 列出每個 agent 及其備份的檔案
  found=0
  while IFS= read -r -d '' agent_dir; do
    agent_id="$(basename "$agent_dir")"

    # 略過非 agent 目錄（README.md、.gitignore 等）
    [[ "$agent_id" == .* ]] && continue
    [[ "$agent_id" == *-snapshot ]] && continue
    [[ "$agent_id" == "pi-prompts"* ]] && continue
    [[ ! -d "$agent_dir" ]] && continue

    echo "  Agent: $agent_id"
    file_count=$(find "$agent_dir" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
    echo "  檔案數: $file_count"

    # 顯示有哪些核心檔案存在
    for f in SOUL.md MEMORY.md IDENTITY.md TOOLS.md USER.md AGENTS.md; do
      [[ -f "$agent_dir/$f" ]] && echo "    ✓ $f"
    done

    memory_count=$(find "$agent_dir/memory" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
    [[ "$memory_count" -gt 0 ]] && echo "    ✓ memory/ ($memory_count 天的記憶筆記)"

    echo ""
    (( found++ )) || true
  done < <(find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d -print0 2>/dev/null)

  if [[ "$found" -eq 0 ]]; then
    echo "  （尚無備份）"
    echo ""
    echo "執行備份："
    echo "  ./scripts/backup-agent-cores.sh"
  fi

  exit 0
fi

# ── 前置檢查 ─────────────────────────────────────────────────────────────────
if [[ ! -d "$BACKUP_DIR" ]]; then
  warn "找不到備份目錄：$BACKUP_DIR"
  warn "請先執行備份："
  warn "  ./scripts/backup-agent-cores.sh"
  exit 1
fi

log "開始還原 agent 核心檔案..."
log "來源目錄: $BACKUP_DIR"
log "目標目錄: $AGENTS_DIR"
$DRY_RUN && log "（dry-run 模式：不會實際複製任何檔案）"
$FORCE    && log "（--force 模式：會覆寫目標端已存在的檔案）"
echo ""

# ── 輔助：還原單一檔案 ────────────────────────────────────────────────────────
restore_file() {
  local src="$1"
  local dst="$2"

  [[ ! -f "$src" ]] && return 0

  local dst_dir
  dst_dir="$(dirname "$dst")"

  # 目標檔案已存在且未強制覆寫：保護既有檔案
  if [[ -f "$dst" ]] && ! $FORCE; then
    (( FILES_PROTECTED++ )) || true
    echo "  [保護] $dst（已存在，使用 --force 覆寫）"
    return 0
  fi

  if $DRY_RUN; then
    echo "  [dry-run] $src"
    echo "         → $dst"
    (( FILES_RESTORED++ )) || true
    return 0
  fi

  mkdir -p "$dst_dir"
  cp "$src" "$dst"
  (( FILES_RESTORED++ )) || true
}

# ── 還原每個 agent ─────────────────────────────────────────────────────────
AGENT_DIRS=()
if [[ -n "$AGENT_FILTER" ]]; then
  if [[ -d "$BACKUP_DIR/$AGENT_FILTER" ]]; then
    AGENT_DIRS=("$BACKUP_DIR/$AGENT_FILTER")
  else
    warn "備份中找不到 agent: $AGENT_FILTER"
    warn "可用的 agents："
    find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d ! -name '.*' ! -name '*-snapshot' -printf "  %f\n" 2>/dev/null
    exit 1
  fi
else
  while IFS= read -r -d '' dir; do
    agent_id="$(basename "$dir")"
    # 略過非 agent 目錄
    [[ "$agent_id" == *-snapshot ]] && continue
    [[ "$agent_id" == "pi-prompts"* ]] && continue
    AGENT_DIRS+=("$dir")
  done < <(find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d ! -name '.*' -print0 2>/dev/null)
fi

if [[ ${#AGENT_DIRS[@]} -eq 0 ]]; then
  warn "在 $BACKUP_DIR 中找不到任何 agent 備份。"
  exit 0
fi

for backup_agent_dir in "${AGENT_DIRS[@]}"; do
  agent_id="$(basename "$backup_agent_dir")"
  dst_agent_dir="$AGENTS_DIR/$agent_id"

  log "▸ 還原 Agent: $agent_id → $dst_agent_dir"

  # 還原所有 .md 檔案（包含 memory/ 子目錄）
  while IFS= read -r -d '' src; do
    rel="${src#"$backup_agent_dir/"}"
    restore_file "$src" "$dst_agent_dir/$rel"
  done < <(find "$backup_agent_dir" -name "*.md" -print0 2>/dev/null)
done

echo ""
log "✅ 還原完成"
log "   已還原: $FILES_RESTORED 個檔案"
log "   已保護: $FILES_PROTECTED 個檔案（目標端已存在）"
log "   已略過: $FILES_SKIPPED 個檔案"
echo ""

if [[ "$FILES_PROTECTED" -gt 0 ]]; then
  log "提示：目標端已有 $FILES_PROTECTED 個檔案被保護（未覆寫）。"
  log "若要強制覆寫，請加上 --force："
  log "  ./scripts/restore-agent-cores.sh --force"
fi

if $DRY_RUN; then
  echo ""
  log "Dry-run 完成。執行以下指令進行真實還原："
  log "  ./scripts/restore-agent-cores.sh [--force]"
fi
