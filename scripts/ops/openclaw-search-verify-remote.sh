#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   scripts/ops/openclaw-search-verify-remote.sh [user@host]

TARGET="${1:-maygo@100.83.81.104}"

ssh "$TARGET" "zsh -ic 'bash -s'" <<'EOF'
set -euo pipefail

echo "## PYTHON"
which python3
python3 --version
pip3 --version

echo "## OPENCLAW STATUS"
openclaw status --json > /tmp/openclaw-status.raw
awk 'f||/^\{/{f=1;print}' /tmp/openclaw-status.raw > /tmp/openclaw-status.json
jq -r '[.update.registry.latestVersion,.gateway.reachable,.os.label,.gateway.self.version] | @tsv' /tmp/openclaw-status.json

echo "## CLAWHUB"
clawhub --cli-version
clawhub list --workdir "$HOME/.openclaw" --dir skills

echo "## OPENCLAW SKILLS READY"
openclaw skills info find-skills
openclaw skills info tavily
openclaw skills info browserwing
openclaw skills info clawfeed
openclaw skills info freeride
openclaw skills info modsearch
openclaw skills info deep-research
openclaw skills info agent-reach

echo "## ADVANCED CLIS"
x-reader
agent-reach doctor
modsearch --help | sed -n '1,20p'
freeride status
python3 ~/.openclaw/workspace/skills/deep-research/scripts/research.py --help | sed -n '1,28p'

echo "## SEARCH SMOKE"
~/.openclaw/skills/ultimate-search/scripts/dual-search.sh --query "OpenClaw docs" | sed -n '1,80p'
EOF
