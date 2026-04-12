#!/usr/bin/env bash
# Fail-fast preflight for PDF pipeline runtime deps.
# Exits 0 on success, 1 on any missing dep or non-writable path.
# Safe to call from both the gateway entrypoint (non-fatal) and the
# pipeline-runner entrypoint (fatal).
set -euo pipefail

VENV="${OCPIPELINE_VENV:-/opt/ocpipeline}"
_ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
fail() { echo "[preflight-pipeline] $(_ts) FAIL $*" >&2; exit 1; }
ok()   { echo "[preflight-pipeline] $(_ts) OK   $*"; }

# ── Java 17+ ─────────────────────────────────────────────────────────────────
java_out="$(java -version 2>&1 | head -1)" || fail "java not found"
echo "$java_out" | grep -qE 'version "(17|2[1-9]|[3-9][0-9])' \
  || fail "java 17+ required (got: ${java_out})"
ok "java ${java_out}"

# ── opendataloader_pdf in venv ────────────────────────────────────────────────
[ -x "${VENV}/bin/python" ] || fail "venv python not found at ${VENV}/bin/python"
import_err="$("${VENV}/bin/python" -c \
  'from opendataloader_pdf import convert; assert callable(convert)' 2>&1)" \
  || fail "opendataloader_pdf not importable from venv ${VENV}: ${import_err}"
pkg_ver="$("${VENV}/bin/pip" show opendataloader-pdf 2>/dev/null | grep '^Version:' | cut -d' ' -f2)"
ok "opendataloader_pdf ${pkg_ver:-installed}"

# ── writable artifact/log paths ───────────────────────────────────────────────
ARTIFACT_ROOT="${OPENCLAW_PIPELINE_ARTIFACT_ROOT:-/home/node/.openclaw/workspace-engineering}"
LOG_DIR="${OPENCLAW_PIPELINE_LOGS:-/home/node/.openclaw/logs/pipeline}"

for dir in \
  "${ARTIFACT_ROOT}/shared/raw/papers" \
  "${ARTIFACT_ROOT}/shared/raw/assets" \
  "${ARTIFACT_ROOT}/.eng/pipeline" \
  "${LOG_DIR}"; do
  mkdir -p "$dir" 2>/dev/null || fail "cannot create dir: ${dir}"
  [ -w "$dir" ] || fail "not writable: ${dir}"
  ok "writable ${dir}"
done

echo "[preflight-pipeline] $(_ts) preflight passed"
