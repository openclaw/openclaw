#!/usr/bin/env bash
set -euo pipefail

# 一鍵流程：同步 upstream -> 驗證 Hybrid/QMD/Mem0 -> 推送分支

TARGET_BRANCH="${1:-agent-grace-upstream-latest}"
SKIP_VERIFY="${SKIP_VERIFY:-0}" # 1=跳過驗證
PUSH_MODE="${PUSH_MODE:-force-with-lease}" # normal | force-with-lease

echo "==> [1/3] 同步 upstream（branch=${TARGET_BRANCH}）"
"$(dirname "$0")/sync-upstream-rebase.sh" "${TARGET_BRANCH}"

if [[ "${SKIP_VERIFY}" == "1" ]]; then
  echo "==> [2/3] 已略過最小驗證（SKIP_VERIFY=1）"
else
  echo "==> [2/3] 執行最小驗證（Hybrid/QMD/Mem0）"
  "$(dirname "$0")/verify-hybrid-memory.sh"
fi

echo "==> [3/3] 推送分支（PUSH_MODE=${PUSH_MODE}）"
PUSH_MODE="${PUSH_MODE}" "$(dirname "$0")/push-integration-branch.sh" "${TARGET_BRANCH}"

echo "==> 全部完成"
