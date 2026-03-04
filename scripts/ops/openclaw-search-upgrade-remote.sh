#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   scripts/ops/openclaw-search-upgrade-remote.sh [user@host]
#
# Default target matches current operator baseline.

TARGET="${1:-maygo@100.83.81.104}"

# shellcheck disable=SC2016
python_upgrade_body='
which python3
python3 --version
brew search ^python@3\.
brew info python@3.14 --json=v2 | jq -r '"'"'(.formulae[0] | .name + " stable=" + .versions.stable + " installed=" + ((.installed[0].version // "none")))'"'"'

brew install python@3.14
brew link python@3.14 --overwrite --force
hash -r

which python3
python3 --version
pip3 --version
'

# shellcheck disable=SC2016
stable_skills_body='
npm i -g clawhub
clawhub --cli-version

for s in find-skills tavily-search browserwing clawfeed-2 free-ride; do
  for i in 1 2 3 4 5; do
    echo "install $s attempt $i"
    if clawhub install "$s" --workdir "$HOME/.openclaw" --dir skills --force; then
      break
    fi
    sleep $((i*8))
  done
done

mkdir -p "$HOME/.openclaw/workspace/skills"
rm -rf /tmp/modsearch /tmp/ai-skills
git clone --depth 1 https://github.com/liustack/modsearch /tmp/modsearch
git clone --depth 1 https://github.com/sanjay3290/ai-skills /tmp/ai-skills

rm -rf "$HOME/.openclaw/workspace/skills/modsearch"
mkdir -p "$HOME/.openclaw/workspace/skills/modsearch"
cp -R /tmp/modsearch/skills/modsearch/. "$HOME/.openclaw/workspace/skills/modsearch/"

rm -rf "$HOME/.openclaw/workspace/skills/deep-research"
mkdir -p "$HOME/.openclaw/workspace/skills/deep-research"
cp -R /tmp/ai-skills/skills/deep-research/. "$HOME/.openclaw/workspace/skills/deep-research/"

# BrowserWing/ClawFeed skills from registry need a small local normalization.
if grep -q '"'"'"requires":{"bins":"env"'"'"' "$HOME/.openclaw/skills/browserwing/SKILL.md"; then
  perl -0777 -i -pe '"'"'s#metadata: \{"moltbot":\{"emoji":"🌐","requires":\{"bins":"env":\["BROWSERWING_EXECUTOR_URL"\]\},"primaryEnv":"BROWSERWING_EXECUTOR_URL"\}\}#metadata: {"clawdbot":{"emoji":"🌐","requires":{"env":["BROWSERWING_EXECUTOR_URL"]},"primaryEnv":"BROWSERWING_EXECUTOR_URL"}}#g'"'"' "$HOME/.openclaw/skills/browserwing/SKILL.md"
fi

if ! head -n 1 "$HOME/.openclaw/skills/clawfeed-2/SKILL.md" | grep -q "^---"; then
  tmpf=$(mktemp)
  cat > "$tmpf" <<'"'"'FM'"'"'
---
name: clawfeed
description: AI-powered news digest tool that generates structured summaries (4H/daily/weekly/monthly) from Twitter, RSS, HackerNews, Reddit, and GitHub Trending.
homepage: https://github.com/kevinho/clawfeed
metadata: {"clawdbot":{"emoji":"📰"}}
---

FM
  cat "$HOME/.openclaw/skills/clawfeed-2/SKILL.md" >> "$tmpf"
  mv "$tmpf" "$HOME/.openclaw/skills/clawfeed-2/SKILL.md"
fi
'

# shellcheck disable=SC2016
advanced_body='
brew install pipx
pipx --version

pipx install --force "x-reader[all] @ git+https://github.com/runesleo/x-reader.git"
~/.local/pipx/venvs/x-reader/bin/python -m playwright install chromium

pipx install --force "https://github.com/Panniantong/agent-reach/archive/main.zip"
agent-reach install --env=auto --safe

npm i -g @liustack/modsearch
pipx install --force ~/.openclaw/skills/free-ride
python3 -m pip install --user --break-system-packages httpx python-dotenv
'

{
  echo "[phase] python upgrade"
  printf '%s\n' "$python_upgrade_body" | sed 's/^/  /'
  echo "[run]"
  ssh "$TARGET" "zsh -ic 'bash -s'" <<<"$python_upgrade_body"

  echo "[phase] stable skills"
  printf '%s\n' "$stable_skills_body" | sed 's/^/  /'
  echo "[run]"
  ssh "$TARGET" "zsh -ic 'bash -s'" <<<"$stable_skills_body"

  echo "[phase] advanced tooling"
  printf '%s\n' "$advanced_body" | sed 's/^/  /'
  echo "[run]"
  ssh "$TARGET" "zsh -ic 'bash -s'" <<<"$advanced_body"
} | tee "/tmp/openclaw-search-upgrade-$(date +%Y%m%d-%H%M%S).log"

echo "Done. Run scripts/ops/openclaw-search-verify-remote.sh $TARGET next."
