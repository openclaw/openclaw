---
name: dna-skill-update
description: Comprehensive backup, update, and restore workflow with dynamic workspace detection
homepage: https://github.com/pasogott/dna-skill-update
metadata: {"dna":{"emoji":"💾","requires":{"bins":["bash","jq","tar","git"]},"tags":["backup","restore","update","multi-agent"]}}
---

# DNA Update Skill

Comprehensive backup, update, and restore workflow for DNA installations.

## Repository

- **GitHub**: https://github.com/dna/dna
- **Upstream**: `origin/main`
- **Local Clone**: `~/code/dna` (default)

## Description

This skill provides a complete, **modular** update workflow for DNA with **dynamic workspace detection**:
- Configuration files
- Agent states and sessions
- Credentials and auth tokens
- **All agent workspaces (auto-detected from config)**
- Cron jobs and sandboxes
- Git repository state

### Key Features

✅ **Dynamic Workspace Detection** - Reads workspace paths from config  
✅ **Multi-Agent Support** - Handles multiple agents automatically  
✅ **Safe Rollback** - Full restore capability  
✅ **Git Integration** - Tracks versions and remotes  
✅ **Validation** - Pre/post checks included  
✅ **Dry Run** - Preview before backup

## Files

- `config.json` - Skill configuration (repo URLs, paths)
- `backup-dna-dryrun.sh` - **Dry run** preview (no changes)
- `backup-dna-full.sh` - **Dynamic** full backup script
- `restore-dna.sh` - **Dynamic** restore script
- `validate-setup.sh` - Pre/post update validation
- `check-upstream.sh` - Check for available updates
- `UPDATE_CHECKLIST.md` - Step-by-step update checklist
- `QUICK_REFERENCE.md` - Quick command reference
- `SKILL.md` - This file
- `README.md` - Quick start guide

### Dynamic Features

Both backup and restore scripts now:
- Read workspace paths from `~/.dna/dna.json`
- Support any number of agents
- Handle missing workspaces gracefully
- Generate safe filenames from agent IDs

## When to Use

Trigger this skill when asked to:
- "update dna"
- "upgrade to latest version"
- "backup dna before update"
- "restore dna from backup"
- "rollback dna update"

## Usage

### 1. Preview Backup (Dry Run)

```bash
~/.skills/dna-update/backup-dna-dryrun.sh
```

**Shows:**
- What files would be backed up
- Estimated backup size
- Workspace detection results
- Disk space availability
- Files that would be skipped

**No files are created or modified!**

### 2. Create Full Backup

```bash
~/.skills/dna-update/backup-dna-full.sh
```

**Backs up:**
- `~/.dna/dna.json` (config)
- `~/.dna/sessions/` (session state)
- `~/.dna/agents/` (multi-agent state)
- `~/.dna/credentials/` (auth tokens)
- `~/.dna/cron/` (scheduled jobs)
- `~/.dna/sandboxes/` (sandbox state)
- All agent workspaces (dynamically detected!)
- Git commit and status

**Output:** `~/.dna-backups/pre-update-YYYYMMDD-HHMMSS/`

### 3. Update DNA

Follow the checklist:

```bash
cat ~/.skills/dna-update/UPDATE_CHECKLIST.md
```

**Key steps:**
1. Create backup
2. Stop gateway
3. Pull latest code
4. Adjust config for breaking changes
5. Run doctor
6. Test functionality
7. Start gateway as daemon

### 4. Restore from Backup

```bash
~/.skills/dna-update/restore-dna.sh ~/.dna-backups/pre-update-YYYYMMDD-HHMMSS
```

**Restores:**
- All configuration
- All state files
- All workspaces
- Optionally: git version

## Important Notes

### Multi-Agent Setup

This skill is designed for multi-agent setups with:
- Multiple agents with separate workspaces
- Sandbox configurations
- Provider routing (WhatsApp/Telegram/Discord/Slack/etc.)

### Breaking Changes in v2026.1.8

**CRITICAL:**
- **DM Lockdown**: DMs now default to `pairing` policy instead of open
- **Groups**: `telegram.groups` and `whatsapp.groups` are now allowlists
- **Sandbox**: Default scope changed to `"agent"` from implicit
- **Timestamps**: Now UTC format in agent envelopes

### Backup Validation

After backup, always verify:
```bash
BACKUP_DIR=~/.dna-backups/pre-update-YYYYMMDD-HHMMSS
cat "$BACKUP_DIR/BACKUP_INFO.txt"
ls -lh "$BACKUP_DIR"
```

Should contain:
- ✅ `dna.json`
- ✅ `credentials.tar.gz`
- ✅ `workspace-*.tar.gz` (one per agent)

### Config Changes Required

**Example: Switch WhatsApp to pairing:**
```bash
jq '.whatsapp.dmPolicy = "pairing"' ~/.dna/dna.json | sponge ~/.dna/dna.json
```

**Example: Set explicit sandbox scope:**
```bash
jq '.agent.sandbox.scope = "agent"' ~/.dna/dna.json | sponge ~/.dna/dna.json
```

## Workflow

### Standard Update Flow

```bash
# 1. Check for updates
~/.skills/dna-update/check-upstream.sh

# 2. Validate current setup
~/.skills/dna-update/validate-setup.sh

# 3. Dry run
~/.skills/dna-update/backup-dna-dryrun.sh

# 4. Backup
~/.skills/dna-update/backup-dna-full.sh

# 5. Stop gateway
cd ~/code/dna
pnpm dna gateway stop

# 6. Update code
git checkout main
git pull --rebase origin main
pnpm install
pnpm build

# 7. Run doctor
pnpm dna doctor --yes

# 8. Test
pnpm dna gateway start  # foreground for testing

# 9. Deploy
pnpm dna gateway stop
pnpm dna gateway start --daemon
```

### Rollback Flow

```bash
# Quick rollback
~/.skills/dna-update/restore-dna.sh <backup-dir>

# Manual rollback
cd ~/code/dna
git checkout <old-commit>
pnpm install && pnpm build
cp <backup-dir>/dna.json ~/.dna/
pnpm dna gateway restart
```

## Testing After Update

### Functionality Tests

- [ ] Provider DMs work (check pairing policy)
- [ ] Group mentions respond
- [ ] Typing indicators work
- [ ] Agent routing works
- [ ] Sandbox isolation works
- [ ] Tool restrictions enforced

### New Features
```bash
pnpm dna agents list
pnpm dna logs --tail 50
pnpm dna providers list --usage
pnpm dna skills list
```

### Monitoring

```bash
# Live logs
pnpm dna logs --follow

# Or Web UI
open http://localhost:3001/logs

# Check status
pnpm dna status
pnpm dna gateway status
```

## Troubleshooting

### Common Issues

**Gateway won't start:**
```bash
pnpm dna logs --grep error
pnpm dna doctor
```

**Auth errors:**
```bash
# OAuth profiles might need re-login
pnpm dna providers login <provider>
```

**Sandbox issues:**
```bash
# Check sandbox config
jq '.agent.sandbox' ~/.dna/dna.json

# Check per-agent sandbox
jq '.routing.agents[] | {name, sandbox}' ~/.dna/dna.json
```

### Emergency Restore

If something goes wrong:

```bash
# 1. Stop gateway
pnpm dna gateway stop

# 2. Full restore
LATEST_BACKUP=$(ls -t ~/.dna-backups/ | head -1)
~/.skills/dna-update/restore-dna.sh ~/.dna-backups/$LATEST_BACKUP

# 3. Restart
pnpm dna gateway start
```

## Installation

### Via ClawdHub

```bash
dna skills install dna-update
```

### Manual

```bash
git clone <repo-url> ~/.skills/dna-update
chmod +x ~/.skills/dna-update/*.sh
```

## License

MIT - see [LICENSE](LICENSE)

## Author

**Pascal Schott** ([@pasogott](https://github.com/pasogott))

Contribution for DNA  
https://github.com/dna/dna
