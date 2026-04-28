#!/usr/bin/env bash
set -euo pipefail

REPO="/home/mertb/.openclaw/workspace/openclaw-src"
BRANCH="pr/pending-final-delivery-hardening"
export PATH="/home/mertb/.nvm/versions/node/v22.22.2/bin:$PATH"

git -C "$REPO" commit -m "fix(subagents): harden deferred completion delivery retry state"
git -C "$REPO" push -u origin "$BRANCH"
