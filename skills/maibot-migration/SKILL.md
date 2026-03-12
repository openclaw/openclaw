---
name: maibot-migration
description: "Migrate MAIBOT (OpenClaw AI Assistant) to a new PC or cloud environment. Use when moving the entire MAIBOT setup — including OpenClaw gateway, workspace, all MAI projects, GPU pipeline, and credentials — to a different machine. Also use for environment recovery (Chrome debug reconnection, gsudo reinstall, dev tool repair). Triggers: 'MAIBOT 이전', '새 PC 세팅', 'PC 마이그레이션', 'migration', 'new PC setup', 'environment setup', '환경 복구', 'Chrome debug', 'gsudo', 'dev tool repair'. NOT for: individual project setup (use mai-project-init), OpenClaw upstream updates (use upstream-sync), regular dev tasks (use hybrid-coding)."
---

# MAIBOT Migration Skill

Migrate the complete MAIBOT environment to a new machine in one shot.

## What Gets Migrated

| Component           | Method                                    |
| ------------------- | ----------------------------------------- |
| OpenClaw Gateway    | `npm i -g openclaw`                       |
| pnpm, EAS CLI       | `npm i -g pnpm@10 eas-cli`                |
| MAIBOT workspace    | `git clone` → `C:\MAIBOT`                 |
| MAI projects (16개) | `git clone` → `C:\TEST\*`                 |
| Claude Code CLI     | `npm i -g @anthropic-ai/claude-code`      |
| OpenClaw config     | `openclaw setup` or manual config         |
| Obsidian vault      | OneDrive sync + symlinks for docs         |
| GPU pipeline        | Conditional (if NVIDIA GPU)               |
| Credentials         | `.env` files — interactive or secure copy |
| Cron jobs           | Re-register 21 jobs                       |
| Python envs         | M.AI.UPbit + MAISECONDBRAIN               |

## Two-Phase Migration

### Phase 1: 지니 Manual (~10 min, before MAIBOT exists)

```powershell
# 1. Install Node.js 22+ (https://nodejs.org) and Git
# 2. Install OpenClaw + pnpm
npm i -g openclaw pnpm@10
# 3. Clone MAIBOT
git clone https://github.com/jini92/MAIBOT.git C:\MAIBOT
# 4. Configure OpenClaw (API keys, Discord token)
openclaw setup
# 5. Start gateway
openclaw gateway start
```

✅ MAIBOT is alive! Discord chat available.

### Phase 2: MAIBOT Auto (Discord: "나머지 세팅해줘")

MAIBOT handles automatically:

- Clone 16 MAI projects (`C:\TEST\*`)
- Install gsudo, Claude Code CLI, EAS CLI
- Chrome debug mode setup (port 18792)
- Python environments (M.AI.UPbit, MAISECONDBRAIN)
- Obsidian symlinks
- Restore 21 cron jobs
- Exec auto-approval config
- Full validation

## Environment Recovery

For partial fixes (Chrome debug, gsudo, dev tools), follow the relevant section in `references/migration-steps.md`.

## References

- `references/migration-steps.md` — Detailed 10-step migration procedure
- `references/env-template.md` — Environment variable templates
- `references/gpu-setup.md` — GPU pipeline setup (SadTalker, TTS, ffmpeg)
- `scripts/migrate.py` — Migration automation script

---

_Skill version: v2.0 — Refactored 2026-03-13_
