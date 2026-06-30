#!/usr/bin/env bash
set -euo pipefail

# 推送整合分支到 origin（rebase 後預設用 --force-with-lease）

TARGET_BRANCH="${1:-agent-grace-upstream-latest}"
PUSH_MODE="${PUSH_MODE:-force-with-lease}" # 可設為: normal

echo "==> 切換分支: ${TARGET_BRANCH}"
git checkout "${TARGET_BRANCH}"

echo "==> 目前狀態"
git status --short --branch

if [[ "${PUSH_MODE}" == "normal" ]]; then
  echo "==> 正常推送"
  git push -u origin "${TARGET_BRANCH}"
else
  echo "==> 使用 --force-with-lease 推送（適用 rebase 後）"
  git push --force-with-lease -u origin "${TARGET_BRANCH}"
fi

echo "==> 推送完成"
