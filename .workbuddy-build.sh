#!/bin/bash
# Live-proof build for PR #198265 (runs inside the 194164 worktree, no matter
# which directory the caller starts from).
set -u
cd /Users/hope/coding-project/openclaw-fix-194164 || exit 2
rm -rf .artifacts/dist-artifacts.lock
export PATH="/Users/hope/.nvm/versions/node/v26.12.1/bin:/tmp/pnpm-shim:$PATH"
export COREPACK_NPM_REGISTRY="https://registry.npmmirror.com"
export CODEBUDDY_SAFE_DELETE_ENABLED=0
node --import ./scripts/tsx.mjs scripts/build-all.mts
rc=$?
echo "build rc=$rc"
if [ $rc -eq 0 ]; then
  stat -f "%Sm %N" dist/extensions/memory-core/index.js
fi
exit $rc
