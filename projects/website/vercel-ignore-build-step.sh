#!/bin/bash

# 檢查是否有需要 rebuild 的變更

echo "🔍 Checking for changes..."

# 檢查 projects/website 目錄
if git diff HEAD^ HEAD --quiet -- projects/website/; then
  echo "   No changes in projects/website/"
  WEBSITE_CHANGED=0
else
  echo "✅ Changes detected in projects/website/"
  WEBSITE_CHANGED=1
fi

# 檢查共用的依賴檔案（root level）
if git diff HEAD^ HEAD --quiet -- package.json pnpm-lock.yaml pnpm-workspace.yaml; then
  echo "   No changes in root dependencies"
  DEPS_CHANGED=0
else
  echo "✅ Changes detected in root dependencies"
  DEPS_CHANGED=1
fi

# 如果 website 或共用依賴有變更，就 build
if [ $WEBSITE_CHANGED -eq 1 ] || [ $DEPS_CHANGED -eq 1 ]; then
  echo "🚀 Proceeding with build"
  exit 1
else
  echo "🛑 No relevant changes, skipping build"
  exit 0
fi
