#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/e2e/lib/bun-global-install/ai-candidate.sh"
PACKAGE_TGZ="${OPENCLAW_BUN_ONLY_SMOKE_PACKAGE_TGZ:?set OPENCLAW_BUN_ONLY_SMOKE_PACKAGE_TGZ}"
ARTIFACT_DIR="${OPENCLAW_BUN_ONLY_SMOKE_ARTIFACT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/openclaw-bun-only.XXXXXX")}"
mkdir -p "$ARTIFACT_DIR"
ARTIFACT_DIR="$(cd "$ARTIFACT_DIR" && pwd)"
echo "Bun-only smoke artifacts: $ARTIFACT_DIR"
BUN_BIN="$(command -v "${BUN_BIN:-bun}")"
# Preserve the resolved binary before masking; fallback Node never appears on a runtime PATH.
INSTALL_NODE="$(node -e 'console.log(require("node:fs").realpathSync(process.execPath))')"
BUN_BIN="$(node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$BUN_BIN")"
PACKAGE_TGZ="$(node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$PACKAGE_TGZ")"
AI_PACKAGE_TGZ=""
REQUIRED_REGISTRY_PACKAGES='[]'
cd "$ROOT_DIR"
mkdir -p "$ARTIFACT_DIR/pack"
prepare_ai_candidate "$PACKAGE_TGZ" "$ARTIFACT_DIR/pack"
if [[ "$REQUIRED_REGISTRY_PACKAGES" != '[]' ]]; then
  echo 'Bun-only smoke requires a candidate containing bundled @openclaw/ai.' >&2
  exit 1
fi
printf '' >"$ARTIFACT_DIR/sentinel-ledger.jsonl"
"$BUN_BIN" "$ROOT_DIR/scripts/e2e/lib/bun-only-runtime/sentinel.mjs" \
  "$ARTIFACT_DIR/sentinel-bin" "$ARTIFACT_DIR/sentinel-ledger.jsonl"
FALLBACK_NODE="$INSTALL_NODE"
if [[ "${OPENCLAW_BUN_ONLY_SMOKE_HIDE_SYSTEM_NODE:-0}" == 1 ]]; then
  command -v unshare setpriv >/dev/null
  FALLBACK_NODE="$ARTIFACT_DIR/install-node"
  printf '' >"$FALLBACK_NODE"
fi
summary_env=()
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  summary_env=("GITHUB_STEP_SUMMARY=$GITHUB_STEP_SUMMARY")
fi
harness_command=(env -i \
  HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-C.UTF-8}" CI="${CI:-1}" \
  "${summary_env[@]}" \
  PATH="$(dirname "$BUN_BIN"):/usr/sbin:/usr/bin:/sbin:/bin" \
  BUN_BIN="$BUN_BIN" \
  OPENCLAW_BUN_ONLY_SMOKE_PACKAGE_TGZ="$PACKAGE_TGZ" \
  OPENCLAW_BUN_ONLY_SMOKE_ARTIFACT_DIR="$ARTIFACT_DIR" \
  OPENCLAW_BUN_ONLY_SMOKE_INSTALL_NODE="$FALLBACK_NODE" \
  OPENCLAW_BUN_ONLY_SMOKE_AI_PACKAGE_TGZ="$AI_PACKAGE_TGZ" \
  "$BUN_BIN" "$ROOT_DIR/scripts/e2e/lib/bun-only-runtime/harness.mjs")
if [[ "${OPENCLAW_BUN_ONLY_SMOKE_HIDE_SYSTEM_NODE:-0}" == 1 ]]; then
  exec sudo -n unshare --mount --propagation private -- bash -c '
    set -euo pipefail
    invoking_uid=$1
    invoking_gid=$2
    install_node=$3
    fallback_node=$4
    sentinel_node=$5
    shift 5
    mount --bind "$install_node" "$fallback_node"
    for entry in /usr/local/bin/node /usr/bin/node; do
      if [[ -e "$entry" ]]; then
        mount --bind "$sentinel_node" "$entry"
      fi
    done
    exec setpriv --reuid="$invoking_uid" --regid="$invoking_gid" --init-groups -- "$@"
  ' bash "$(id -u)" "$(id -g)" "$INSTALL_NODE" "$FALLBACK_NODE" \
    "$ARTIFACT_DIR/sentinel-bin/node" "${harness_command[@]}"
fi
exec "${harness_command[@]}"
