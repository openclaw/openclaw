#!/bin/bash
# Consensus Engine — Tri-Model Verify
# Logs consensus results to memory/consensus-log.jsonl
# Usage: consensus-engine.sh <prompt_hash> <divergence_level> <confidence> <result>

LOG_FILE="/home/i/clawd/memory/consensus-log.jsonl"

PROMPT_HASH="${1:-unknown}"
DIVERGENCE="${2:-unknown}"
CONFIDENCE="${3:-unknown}"
RESULT="${4:-unknown}"

echo "{\"id\":\"$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"prompt_hash\":\"$PROMPT_HASH\",\"models_used\":[\"opus-4.6\",\"kimi-k2.5\",\"deepseek-v3.2\"],\"divergence_level\":\"$DIVERGENCE\",\"confidence\":\"$CONFIDENCE\",\"arbitration_model\":\"opus-4.6\",\"result\":\"$RESULT\"}" >> "$LOG_FILE"

echo "Logged to $LOG_FILE"
