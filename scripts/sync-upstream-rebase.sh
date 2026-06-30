#!/usr/bin/env bash
set -euo pipefail

# OpenClaw upstream 同步腳本（保留目前分支客製化）

TARGET_BRANCH="${1:-agent-grace-upstream-latest}"
REMOTE_UPSTREAM="${REMOTE_UPSTREAM:-upstream}"
BASE_REF="${BASE_REF:-upstream/main}"

echo "==> 準備同步分支: ${TARGET_BRANCH}"
git checkout "${TARGET_BRANCH}"

echo "==> 目前狀態"
git status --short --branch

echo "==> 取得 upstream 最新版本"
git fetch "${REMOTE_UPSTREAM}" main

echo "==> rebase 到 ${BASE_REF}"
if git rebase "${BASE_REF}"; then
  echo "==> rebase 完成"
else
  echo ""
  echo "rebase 發生衝突，請依序執行："
  echo "1) git status"
  echo "2) 手動解衝突後 git add <檔案>"
  echo "3) GIT_EDITOR=true git -c core.hooksPath=/dev/null rebase --continue"
  echo "   （重複直到完成）"
  echo "4) 若要取消：git rebase --abort"
  exit 1
fi

echo "==> 驗證與 upstream 差異（格式：behind ahead）"
git rev-list --left-right --count "${BASE_REF}...HEAD"

echo "==> 最近 commit"
git log --oneline -n 5
