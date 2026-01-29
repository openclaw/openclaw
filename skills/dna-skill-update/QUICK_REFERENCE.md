# DNA Update - Quick Reference Card

## 🚀 One-Liner Commands

```bash
# Dry run (preview backup)
~/.skills/dna-update/backup-dna-dryrun.sh

# Backup everything
~/.skills/dna-update/backup-dna-full.sh

# Show checklist
cat ~/.skills/dna-update/UPDATE_CHECKLIST.md

# Restore from backup
~/.skills/dna-update/restore-dna.sh <backup-dir>

# List backups
ls -lth ~/.dna-backups/

# View last backup
cat $(ls -td ~/.dna-backups/*/ | head -1)/BACKUP_INFO.txt
```

## ⚡ Emergency Rollback

```bash
# Stop gateway
cd ~/code/dna && pnpm dna gateway stop

# Restore latest backup
LATEST=$(ls -t ~/.dna-backups/ | head -1)
~/.skills/dna-update/restore-dna.sh ~/.dna-backups/$LATEST

# Start gateway
pnpm dna gateway start
```

## 🔧 Config Quick Fixes

```bash
# Switch to pairing (recommended)
jq '.whatsapp.dmPolicy = "pairing" | .telegram.dmPolicy = "pairing"' ~/.dna/dna.json | sponge ~/.dna/dna.json

# Set explicit sandbox scope
jq '.agent.sandbox.scope = "agent"' ~/.dna/dna.json | sponge ~/.dna/dna.json

# Set user timezone
jq '.agent.userTimezone = "America/New_York"' ~/.dna/dna.json | sponge ~/.dna/dna.json

# View current config
jq '.' ~/.dna/dna.json | less
```

## 📊 Status Checks

```bash
# Gateway status
pnpm dna gateway status

# Live logs
pnpm dna logs --follow

# Agents
pnpm dna agents list

# Providers with usage
pnpm dna providers list --usage

# Full status
pnpm dna status
```

## 🧪 Test Commands

```bash
# New CLIs
pnpm dna agents list
pnpm dna logs --tail 50
pnpm dna providers list --usage
pnpm dna skills list

# Web UI
open http://localhost:3001/logs

# Check routing
jq '.routing.bindings' ~/.dna/dna.json
```

## 🎯 Critical Checks

```bash
# DM policies
jq '.whatsapp.dmPolicy, .telegram.dmPolicy' ~/.dna/dna.json

# Groups config
jq '.telegram.groups, .whatsapp.groups' ~/.dna/dna.json

# Sandbox config
jq '.agent.sandbox' ~/.dna/dna.json

# Per-agent config
jq '.routing.agents[] | {name, workspace, sandbox}' ~/.dna/dna.json

# Workspaces list
jq -r '.routing.agents | to_entries[] | "\(.key): \(.value.workspace)"' ~/.dna/dna.json
```

## 🔥 Troubleshooting

```bash
# Logs with errors
pnpm dna logs --grep error

# Run doctor
pnpm dna doctor --yes

# Restart gateway
pnpm dna gateway restart

# Kill stuck processes
pkill -f "dna gateway"

# Check gateway ports
lsof -i :3001 -i :3002
```

## 📦 Update Flow (Copy-Paste)

```bash
# 0. Dry run (optional)
~/.skills/dna-update/backup-dna-dryrun.sh

# 1. Backup
~/.skills/dna-update/backup-dna-full.sh

# 2. Stop
cd ~/code/dna && pnpm dna gateway stop

# 3. Update
git checkout main
git pull --rebase origin main
pnpm install
pnpm build

# 4. Config (adjust as needed)
jq '.whatsapp.dmPolicy = "pairing"' ~/.dna/dna.json | sponge ~/.dna/dna.json
jq '.agent.sandbox.scope = "agent"' ~/.dna/dna.json | sponge ~/.dna/dna.json

# 5. Doctor
pnpm dna doctor --yes

# 6. Start
pnpm dna gateway start --daemon

# 7. Verify
pnpm dna gateway status
pnpm dna logs --tail 20
```

## 🎓 Version Check

```bash
# Current version
cd ~/code/dna && git log -1 --oneline

# Upstream version
git fetch origin && git log main..origin/main --oneline | head -5

# Check for updates
git fetch origin && git diff --stat main..origin/main
```

## 💾 Workspace Checks

```bash
# List configured workspaces
jq -r '.routing.agents | to_entries[] | "\(.key): \(.value.workspace)"' ~/.dna/dna.json

# Check workspace sizes
du -sh ~/clawd*

# Check .dna size
du -sh ~/.dna

# Backup size
du -sh ~/.dna-backups/
```

## 🔐 Auth Check

```bash
# List credentials
ls -la ~/.dna/credentials/

# Check auth profiles
jq '.models' ~/.dna/dna.json

# Provider login status
pnpm dna providers list
```

## ⏱️ Time Estimates

| Task | Time |
|------|------|
| Backup | 2-3 min |
| Update code | 3-5 min |
| Config changes | 5-10 min |
| Doctor | 2-3 min |
| Testing | 10-15 min |
| **Total** | **25-35 min** |

## 📞 Emergency Contacts

**Logs:** `~/.dna/logs/`  
**Backups:** `~/.dna-backups/`  
**Config:** `~/.dna/dna.json`  
**Skill:** `~/.skills/dna-update/`

---

**Last Updated:** 2026-01-08  
**Target Version:** v2026.1.8  
**Repository:** https://github.com/dna/dna
