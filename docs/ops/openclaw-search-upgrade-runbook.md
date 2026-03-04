# OpenClaw Search Stack Upgrade Runbook

Issue: https://github.com/HamsteRider-m/hamclaw/issues/2

## Goal

Upgrade the remote OpenClaw operator host (`maygo@100.83.81.104`) to:

1. Python `3.14.x` as default `python3`.
2. Stable search skills set:
   `find-skills`, `tavily-search`, `browserwing`, `clawfeed-2`, `free-ride`, plus manual `modsearch` and `deep-research`.
3. Phase-2 tooling:
   `x-reader` and `agent-reach`.

## Safety Constraints

1. Do not write real API keys or cookies in scripts/logs.
2. Keep `agent-reach` in safe mode for baseline install.
3. Treat key-bound modules as "framework installed, pending key-based validation".

## One-Shot Execution

From repo root:

```bash
scripts/ops/openclaw-search-upgrade-remote.sh maygo@100.83.81.104
```

Then verify:

```bash
scripts/ops/openclaw-search-verify-remote.sh maygo@100.83.81.104
```

## What Changes on Remote

1. `python3` switches from system `3.9.6` to Homebrew `3.14.3`.
2. New skills under `~/.openclaw/skills`:
   `find-skills`, `tavily-search`, `browserwing`, `clawfeed-2`, `free-ride`, `agent-reach`.
3. New skills under `~/.openclaw/workspace/skills`:
   `modsearch`, `deep-research`.
4. New CLIs:
   `clawhub`, `x-reader`, `agent-reach`, `modsearch`, `freeride`.

## Rollback

Python rollback:

```bash
ssh maygo@100.83.81.104 'zsh -ic "brew unlink python@3.14; hash -r; which python3; python3 --version"'
```

Skill rollback (example):

```bash
ssh maygo@100.83.81.104 'zsh -ic "rm -rf ~/.openclaw/skills/{find-skills,tavily-search,browserwing,clawfeed-2,free-ride,agent-reach} ~/.openclaw/workspace/skills/{modsearch,deep-research}"'
```

Optional CLI rollback:

```bash
ssh maygo@100.83.81.104 'zsh -ic "npm rm -g clawhub @liustack/modsearch; pipx uninstall x-reader || true; pipx uninstall agent-reach || true; pipx uninstall freeride || true"'
```

## Notes

1. Homebrew Python 3.14 enforces PEP 668. Global `pip install` is blocked by default.
2. To avoid breaking Homebrew-managed Python, `pipx` is used for app-style CLI installs.
3. `browserwing` and `clawfeed-2` registry payloads required local SKILL frontmatter normalization for OpenClaw parser compatibility.
