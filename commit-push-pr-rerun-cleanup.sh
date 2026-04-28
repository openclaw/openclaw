#!/usr/bin/env bash
set -euo pipefail

REPO="/home/mertb/.openclaw/workspace/openclaw-src"
BRANCH="pr/pending-final-delivery-hardening"
export PATH="/home/mertb/.nvm/versions/node/v22.22.2/bin:$PATH"

git -C "$REPO" add src/agents/subagent-registry-lifecycle.ts
git -C "$REPO" commit -m "style(subagents): remove dead conditional in deferred delivery error"
git -C "$REPO" push origin "$BRANCH"
