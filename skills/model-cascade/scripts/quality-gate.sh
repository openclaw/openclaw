#!/bin/bash
# Quality Gate Logger — Model Cascade
# Logs cascade attempts to memory/cascade-log.jsonl
# Usage: quality-gate.sh <prompt_hash> <levels_attempted> <accepted_level> <model> <scores_csv> <time_ms>

LOG_FILE="/home/i/clawd/memory/cascade-log.jsonl"

PROMPT_HASH="${1:-unknown}"
LEVELS="${2:-0}"
ACCEPTED="${3:-0}"
MODEL="${4:-unknown}"
SCORES="${5:-[]}"
TIME_MS="${6:-0}"

echo "{\"id\":\"$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"prompt_hash\":\"$PROMPT_HASH\",\"levels_attempted\":$LEVELS,\"accepted_at_level\":$ACCEPTED,\"model_used\":\"$MODEL\",\"quality_scores\":[$SCORES],\"total_time_ms\":$TIME_MS}" >> "$LOG_FILE"

echo "Logged to $LOG_FILE"
