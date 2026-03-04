#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

MODE="${1:-dry-run}"
CHANGE_CMD="${2:-}"
FULL_TESTS="${MONSTER_FULL_TESTS:-0}"

if [[ "$MODE" != "dry-run" && "$MODE" != "apply" ]]; then
  echo "Usage: scripts/monster/safe-self-evolve.sh [dry-run|apply] [\"change command\"]"
  exit 1
fi

if [[ "$MODE" == "apply" && -z "$CHANGE_CMD" ]]; then
  echo "apply mode requires a change command string"
  exit 1
fi

if [[ "$MODE" == "apply" && -z "${MONSTER_APPROVAL_NOTE:-}" ]]; then
  echo "apply mode requires explicit approval note: set MONSTER_APPROVAL_NOTE"
  exit 1
fi

if [[ "${MONSTER_ALLOW_DIRTY:-0}" != "1" ]]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "working tree must be clean before self-evolution (or set MONSTER_ALLOW_DIRTY=1)"
    exit 2
  fi
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
WORK_BRANCH="codex/monster-evolve-${STAMP}"
ARTIFACT_DIR=".artifacts/monster/${STAMP}"
mkdir -p "$ARTIFACT_DIR"

echo "[monster] base branch: $CURRENT_BRANCH" | tee "$ARTIFACT_DIR/summary.txt"
echo "[monster] work branch: $WORK_BRANCH" | tee -a "$ARTIFACT_DIR/summary.txt"
if [[ -n "${MONSTER_APPROVAL_NOTE:-}" ]]; then
  echo "[monster] approval note: ${MONSTER_APPROVAL_NOTE}" | tee -a "$ARTIFACT_DIR/summary.txt"
fi

git checkout -b "$WORK_BRANCH" >/dev/null

if [[ "$MODE" == "apply" ]]; then
  echo "[monster] applying change command" | tee -a "$ARTIFACT_DIR/summary.txt"
  bash -lc "$CHANGE_CMD" 2>&1 | tee "$ARTIFACT_DIR/change-command.log"
else
  echo "[monster] dry-run only; no code changes applied" | tee -a "$ARTIFACT_DIR/summary.txt"
fi

run_gate() {
  local label="$1"
  local cmd="$2"
  local log_file="$ARTIFACT_DIR/${label}.log"
  echo "[monster] gate: $label" | tee -a "$ARTIFACT_DIR/summary.txt"
  if bash -lc "$cmd" >"$log_file" 2>&1; then
    echo "[monster] PASS $label" | tee -a "$ARTIFACT_DIR/summary.txt"
  else
    echo "[monster] FAIL $label" | tee -a "$ARTIFACT_DIR/summary.txt"
    echo "[monster] logs: $log_file" | tee -a "$ARTIFACT_DIR/summary.txt"
    echo "[monster] rollback: git checkout $CURRENT_BRANCH && git branch -D $WORK_BRANCH" | tee -a "$ARTIFACT_DIR/summary.txt"
    exit 3
  fi
}

run_gate format_check "pnpm format:check"
run_gate typecheck "pnpm tsgo"
run_gate build_smoke "pnpm build:strict-smoke"
run_gate unit_fast "pnpm test:fast"
run_gate channels "pnpm test:channels"
run_gate monster_config_validate "OPENCLAW_CONFIG_PATH=$ROOT_DIR/configs/openclaw.monster.v2026.3.2.json OPENCLAW_WORKSPACE=$ROOT_DIR TELEGRAM_BOT_TOKEN=dummy pnpm openclaw config validate --json"

if [[ "$FULL_TESTS" == "1" ]]; then
  run_gate extensions "pnpm test:extensions"
  run_gate gateway "pnpm test:gateway"
fi

git status --short > "$ARTIFACT_DIR/git-status.txt"
git diff > "$ARTIFACT_DIR/git.diff"

echo "[monster] all gates passed" | tee -a "$ARTIFACT_DIR/summary.txt"
echo "[monster] next: review diff, then merge to $CURRENT_BRANCH" | tee -a "$ARTIFACT_DIR/summary.txt"
