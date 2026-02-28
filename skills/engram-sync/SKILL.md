---
name: engram-sync
description: "Sync Engram persistent memory across machines via Git. Use when: user asks to sync, push, pull or share Engram memory, or says 'sync memory', 'sincroniza la memoria', 'sync engram'. Always does a full bidirectional sync (export + push + pull + import) without asking."
homepage: https://github.com/FelipePepe/engram-memory
metadata: { "openclaw": { "emoji": "🧠", "requires": { "bins": ["engram", "git"] } } }
---

# Engram Memory Sync

Syncs Engram persistent AI memory across machines using a private Git repo as transport.

## Setup

- Sync repo: `~/engram-memory`
- Remote: `https://github.com/FelipePepe/engram-memory`
- Never commit `engram.db` — only chunks and manifest

## Instructions

Always perform a **full bidirectional sync** without asking the user:

1. Export local memories to chunks
2. Commit and push to GitHub
3. Pull changes from other machines
4. Import any new chunks into local DB

```bash
cd ~/engram-memory && \
engram sync --all && \
git add -A && \
git commit -m "sync: $(hostname) $(date '+%Y-%m-%d %H:%M')" --allow-empty && \
git pull --rebase && \
git push && \
engram sync --import
```

Report a brief summary of what was synced (chunks exported, observations imported).
If `git pull` causes a rebase conflict, show the conflicting files and stop.
