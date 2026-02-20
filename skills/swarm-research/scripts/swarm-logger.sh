#!/bin/bash
# Swarm Logger — Swarm Research
# Logs swarm execution metrics to memory/swarm-log.jsonl
# Usage: swarm-logger.sh <task_hash> <planned> <completed> <failed> <time_ms> <speedup> <quality>

LOG_FILE="/home/i/clawd/memory/swarm-log.jsonl"

TASK_HASH="${1:-unknown}"
PLANNED="${2:-0}"
COMPLETED="${3:-0}"
FAILED="${4:-0}"
TIME_MS="${5:-0}"
SPEEDUP="${6:-1.0}"
QUALITY="${7:-0.0}"

echo "{\"id\":\"$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"task_hash\":\"$TASK_HASH\",\"sub_tasks_planned\":$PLANNED,\"sub_tasks_completed\":$COMPLETED,\"sub_tasks_failed\":$FAILED,\"execution_time_ms\":$TIME_MS,\"speedup_vs_sequential\":$SPEEDUP,\"opus_quality_score\":$QUALITY}" >> "$LOG_FILE"

echo "Logged to $LOG_FILE"
