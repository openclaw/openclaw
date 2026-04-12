#!/usr/bin/env bash
# Non-interactive PDF pipeline runner entrypoint.
#
# Lifecycle:
#   1. Load required Docker secrets into env vars
#   2. Run preflight checks (fail-fast: non-zero exits are NOT retried)
#   3. Acquire concurrency lock (exit immediately if another runner is live)
#   4. Run linear_eng_pipeline.py in a retry loop:
#        exit 0  → clean run; sleep and loop (reset retry counter)
#        exit 1  → fatal/config error; write alert, release lock, exit 1
#        other   → transient error; retry up to PIPELINE_MAX_RETRIES times
#
# Environment tunables (all have defaults):
#   PIPELINE_MAX_RETRIES         max transient retries per run cycle (default: 5)
#   PIPELINE_RETRY_DELAY_SEC     seconds between retries (default: 30)
#   PIPELINE_SCHEDULE_INTERVAL_SEC  idle sleep between clean runs (default: 300)
#   OPENCLAW_CONFIG_DIR          openclaw config/workspace root (default: /home/node/.openclaw)
#   OPENCLAW_PIPELINE_LOGS       log output directory
#   OPENCLAW_PIPELINE_ARTIFACT_ROOT  workspace root for artifact path checks
#   OCPIPELINE_VENV              path to Python venv (default: /opt/ocpipeline)
set -euo pipefail

LOG() { echo "[pipeline-runner] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# ── load Docker secrets ───────────────────────────────────────────────────────
for secret in linear_api_key github_token; do
  path="/run/secrets/${secret}"
  if [ ! -f "$path" ] || [ ! -s "$path" ]; then
    LOG "FATAL missing or empty secret: ${secret} (expected at ${path})"
    exit 1
  fi
  # Export as uppercase env var (linear_api_key → LINEAR_API_KEY)
  varname="$(echo "$secret" | tr '[:lower:]' '[:upper:]')"
  export "${varname}"="$(cat "$path")"
done

export OPENCLAW_PIPELINE_VENV="${OCPIPELINE_VENV:-/opt/ocpipeline}"
export OPENCLAW_PIPELINE_LOGS="${OPENCLAW_PIPELINE_LOGS:-/home/node/.openclaw/logs/pipeline}"
export OPENCLAW_PIPELINE_ARTIFACT_ROOT="${OPENCLAW_PIPELINE_ARTIFACT_ROOT:-/home/node/.openclaw/workspace-engineering}"

# ── preflight (fail-fast; never retried) ─────────────────────────────────────
LOG "INFO  running preflight checks"
if ! /usr/local/bin/preflight-pipeline.sh; then
  LOG "FATAL preflight failed — aborting (will not retry)"
  exit 1
fi

# ── concurrency lock ──────────────────────────────────────────────────────────
CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-/home/node/.openclaw}"
LOCKFILE="${CONFIG_DIR}/workspace-engineering/.eng/pipeline/runner.lock"

mkdir -p "$(dirname "$LOCKFILE")"

if [ -f "$LOCKFILE" ]; then
  existing_pid="$(cat "$LOCKFILE" 2>/dev/null || echo "")"
  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
    LOG "FATAL runner lock held by live PID ${existing_pid} — exiting to prevent overlap"
    exit 1
  fi
  LOG "INFO  clearing stale lock (PID ${existing_pid:-unknown} no longer running)"
  rm -f "$LOCKFILE"
fi

echo $$ > "$LOCKFILE"
# Release lock on SIGTERM/SIGINT (graceful shutdown)
trap 'LOG "INFO  received shutdown signal; releasing lock"; rm -f "$LOCKFILE"; exit 0' TERM INT

LOG "INFO  lock acquired (PID $$, lockfile: ${LOCKFILE})"

# ── retry loop ────────────────────────────────────────────────────────────────
MAX_RETRIES="${PIPELINE_MAX_RETRIES:-5}"
RETRY_DELAY="${PIPELINE_RETRY_DELAY_SEC:-30}"
SCHEDULE_INTERVAL="${PIPELINE_SCHEDULE_INTERVAL_SEC:-300}"
attempt=0

cd "${CONFIG_DIR}/workspace-engineering"

while true; do
  attempt=$((attempt + 1))
  log_file="${OPENCLAW_PIPELINE_LOGS}/pipeline-$(date -u +%Y%m%d).log"
  LOG "INFO  run attempt ${attempt} (log: ${log_file})"

  exit_code=0
  "${OPENCLAW_PIPELINE_VENV}/bin/python" scripts/linear_eng_pipeline.py \
    2>&1 | tee -a "$log_file" \
    || exit_code=$?

  # ── clean exit ──────────────────────────────────────────────────────────────
  if [ "$exit_code" -eq 0 ]; then
    LOG "INFO  run completed successfully; sleeping ${SCHEDULE_INTERVAL}s before next cycle"
    attempt=0
    sleep "$SCHEDULE_INTERVAL"
    continue
  fi

  # ── fatal (exit 1 = config/validation error) — do not retry ─────────────────
  if [ "$exit_code" -eq 1 ]; then
    LOG "FATAL run exited with code 1 (non-transient error); alerting and stopping"
    printf '{"level":"fatal","event":"pipeline_fatal","exit_code":1,"attempt":%d,"ts":"%s"}\n' \
      "$attempt" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      >> "${OPENCLAW_PIPELINE_LOGS}/pipeline-alerts.jsonl"
    rm -f "$LOCKFILE"
    exit 1
  fi

  # ── transient error — retry up to MAX_RETRIES ────────────────────────────────
  if [ "$attempt" -ge "$MAX_RETRIES" ]; then
    LOG "ERROR max retries (${MAX_RETRIES}) exceeded (last exit: ${exit_code}); alerting and stopping"
    printf '{"level":"error","event":"pipeline_max_retries","exit_code":%d,"attempt":%d,"max_retries":%d,"ts":"%s"}\n' \
      "$exit_code" "$attempt" "$MAX_RETRIES" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      >> "${OPENCLAW_PIPELINE_LOGS}/pipeline-alerts.jsonl"
    rm -f "$LOCKFILE"
    exit "$exit_code"
  fi

  LOG "WARN  transient error (exit ${exit_code}), retry ${attempt}/${MAX_RETRIES} in ${RETRY_DELAY}s"
  sleep "$RETRY_DELAY"
done
