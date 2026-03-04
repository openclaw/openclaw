# OpenClaw Search Upgrade Evidence (2026-03-04)

Issue: https://github.com/HamsteRider-m/hamclaw/issues/2

Host: `maygo@100.83.81.104`

## 1) Python Upgrade

Command:

```bash
ssh maygo@100.83.81.104 'zsh -ic "which python3; python3 --version; pip3 --version"'
```

Key output:

```text
/opt/homebrew/bin/python3
Python 3.14.3
pip 26.0 from /opt/homebrew/lib/python3.14/site-packages/pip (python 3.14)
```

## 2) OpenClaw Health

Command:

```bash
ssh maygo@100.83.81.104 'zsh -ic "openclaw status --json > /tmp/openclaw-status.raw; awk '\''f||/^\{/{f=1;print}'\'' /tmp/openclaw-status.raw > /tmp/openclaw-status.json; jq -r '\''[.update.registry.latestVersion,.gateway.reachable,.os.label,.gateway.self.version] | @tsv'\'' /tmp/openclaw-status.json"'
```

Key output:

```text
2026.3.2	true	macos 26.3 (arm64)	2026.3.2
```

## 3) Stable Skills Installed

Commands:

```bash
ssh maygo@100.83.81.104 'zsh -ic "clawhub --cli-version; clawhub list --workdir ~/.openclaw --dir skills"'
```

Key output:

```text
0.7.0
find-skills  0.1.0
tavily-search  1.0.0
browserwing  1.0.0
clawfeed-2  0.1.0
free-ride  1.0.4
```

## 4) Skills Ready in OpenClaw

Command:

```bash
ssh maygo@100.83.81.104 'zsh -ic "openclaw skills list > /tmp/skills.list.txt; grep -nE '\''browserwing|clawfeed|tavily|freeride|find-skills|modsearch|deep-research|agent-reach'\'' /tmp/skills.list.txt"'
```

Key output:

```text
149: ... agent-reach ... openclaw-managed
158: ... browserwing ... openclaw-managed
162: ... clawfeed ... openclaw-managed
165: ... find-skills ... openclaw-managed
171: ... freeride ... openclaw-managed
176: ... tavily ... openclaw-managed
192: ... deep-research ... openclaw-workspace
202: ... modsearch ... openclaw-workspace
```

## 5) Phase-2 Tooling Checks

Commands:

```bash
ssh maygo@100.83.81.104 'zsh -ic "x-reader; agent-reach doctor; modsearch --help | sed -n '\''1,20p'\''; freeride status; python3 ~/.openclaw/workspace/skills/deep-research/scripts/research.py --help | sed -n '\''1,28p'\''"'
```

Key output (abridged):

```text
x-reader — Universal content reader
agent-reach: 状态 3/12 个渠道可用 (safe baseline, no cookies/keys)
modsearch --help: Usage + options shown
freeride status: OpenRouter API Key: NOT SET
research.py --help: usage/options shown
```

## 6) Ultimate Search Smoke Test

Command:

```bash
ssh maygo@100.83.81.104 'zsh -ic "~/.openclaw/skills/ultimate-search/scripts/dual-search.sh --query \"OpenClaw docs\" | sed -n '\''1,80p'\''"'
```

Key output (abridged):

```text
JSON returned with both grok and tavily branches populated.
tavily top result includes https://docs.openclaw.ai/
```

## 7) Pending Key-Based Validation (Expected)

1. `freeride`: requires `OPENROUTER_API_KEY`.
2. `modsearch` default provider: requires Gemini CLI auth.
3. `deep-research`: requires `GEMINI_API_KEY`.

Current state is intentional: framework and command paths are installed; secrets are not injected in this rollout.
