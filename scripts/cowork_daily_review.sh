#!/bin/bash
# cowork_daily_review.sh — Claude CLI로 Cowork 일일 점검 실행
# LaunchAgent에서 매일 04:00 KST 호출

set -eo pipefail

SCRIPTS_DIR="$HOME/.openclaw/workspace/scripts"
PROMPT_FILE="$SCRIPTS_DIR/cowork_daily_prompt.md"
HISTORY_FILE="$HOME/.openclaw/workspace/memory/cowork-history/latest.json"
LOG_DIR="$HOME/.openclaw/logs"
LOG_FILE="$LOG_DIR/cowork_daily_review.log"
CLAUDE_BIN="$HOME/.local/bin/claude"
MAX_BUDGET=10       # USD per run (10작업 기준 ~$5, 여유 포함)
TIMEOUT_SEC=3600    # 60분 제한

BOT_TOKEN="8554125313:AAGC5Zzb9nCbPYgmOVqs3pVn-qzIA2oOtkI"
CHAT_ID="492860021"

# 중첩 세션 방지 해제 (수동 테스트 시 필요, LaunchAgent에서는 무관)
unset CLAUDECODE 2>/dev/null || true

mkdir -p "$LOG_DIR"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

send_telegram() {
    local msg="$1"
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d chat_id="$CHAT_ID" \
        -d parse_mode="Markdown" \
        --data-urlencode "text=$msg" \
        > /dev/null 2>&1 || log "WARN: Telegram send failed"
}

log "=== Cowork daily review started ==="

# 1) system_digest 먼저 갱신 (최신 진단 데이터 확보)
log "Running system_digest.py..."
cd "$SCRIPTS_DIR"
python3 pipeline/system_digest.py >> "$LOG_FILE" 2>&1 || log "WARN: system_digest failed"

# 2) Claude CLI 실행 (Opus, stream-json으로 중간 출력 확보 + hang 방지)
log "Running claude CLI (budget: \$${MAX_BUDGET}, timeout: ${TIMEOUT_SEC}s)..."
# macOS에는 GNU timeout이 없으므로 background + wait로 구현
bash -c "
    cat \"$PROMPT_FILE\" | \"$CLAUDE_BIN\" \
        -p \
        --model opus \
        --dangerously-skip-permissions \
        --no-session-persistence \
        --max-budget-usd $MAX_BUDGET \
        --verbose \
        --output-format stream-json \
        --add-dir \"$HOME/.openclaw\" \
        --add-dir \"$HOME/knowledge\"
" >> "$LOG_FILE" 2>&1 &
CLAUDE_PID=$!

# 타임아웃 감시
(sleep "$TIMEOUT_SEC" && kill "$CLAUDE_PID" 2>/dev/null && log "WARN: Claude CLI timed out after ${TIMEOUT_SEC}s") &
TIMER_PID=$!

wait "$CLAUDE_PID" 2>/dev/null
EXIT_CODE=$?

# 타이머 정리 (정상 종료 시)
kill "$TIMER_PID" 2>/dev/null
wait "$TIMER_PID" 2>/dev/null
log "Claude CLI exited with code: $EXIT_CODE"

# 3) 텔레그램 보고 (Opus가 못 보냈을 경우 fallback)
log "Sending Telegram report..."
if [ -f "$HISTORY_FILE" ]; then
    REPORT=$(python3 << 'PYEOF'
import json, os
hf = os.path.expanduser("~/.openclaw/workspace/memory/cowork-history/latest.json")
try:
    d = json.load(open(hf))
    lines = []
    date_str = d.get("date", "?")
    # 월/일 형식
    parts = date_str.split("-")
    if len(parts) == 3:
        date_display = f"{int(parts[1])}월 {int(parts[2])}일"
    else:
        date_display = date_str

    lines.append(f"🧠 Cowork 새벽 점검 | {date_display}")
    lines.append("")
    lines.append(d.get("diagnosis_summary", ""))
    lines.append("")

    imps = d.get("improvements", [])
    if imps:
        lines.append(f"오늘 {len(imps)}가지 작업:")
        lines.append("")
        for i, imp in enumerate(imps, 1):
            icon = "✅" if imp.get("status") == "success" else "⚠️" if imp.get("status") == "partial" else "❌"
            task = imp.get("task", "?")
            # why/what 형식 (새 프롬프트) 또는 detail 형식 (구 프롬프트) 대응
            why = imp.get("why", "")
            what = imp.get("what", "")
            detail = imp.get("detail", "")
            if why and what:
                lines.append(f"{i}. {icon} {task}")
                lines.append(f"   → {why}")
                lines.append(f"   → {what}")
            elif detail:
                lines.append(f"{i}. {icon} {task}")
                lines.append(f"   → {detail[:120]}")
            else:
                lines.append(f"{i}. {icon} {task}")
            lines.append("")

    tomorrow = d.get("tomorrow_priority", [])
    if tomorrow:
        lines.append("내일 확인할 것:")
        for p in tomorrow[:3]:
            lines.append(f"• {p}")
        lines.append("")

    test = d.get("test_result", "")
    if test:
        lines.append(f"테스트: {test}")

    print("\n".join(lines))
except Exception as e:
    print(f"🧠 Cowork 새벽 점검 완료. 상세는 cowork-history 참고.")
PYEOF
)
    send_telegram "$REPORT"
    log "Telegram report sent"
else
    send_telegram "🧠 Cowork 새벽 점검 실행했는데 이력 파일이 안 만들어졌어요. 로그 확인 필요."
    log "WARN: No history file, sent minimal report"
fi

log "=== Cowork daily review finished ==="
