# DNA Update Skill

Complete **modular** backup, update, and restore workflow for DNA installations.

**Repository**: https://github.com/dna/dna

## Quick Start

```bash
# 0. Dry run (see what would be backed up)
~/.skills/dna-skill-update/backup-dna-dryrun.sh

# 1. Create backup
~/.skills/dna-skill-update/backup-dna-full.sh

# 2. Follow checklist
cat ~/.skills/dna-skill-update/UPDATE_CHECKLIST.md

# 3. Restore if needed
~/.skills/dna-skill-update/restore-dna.sh <backup-dir>
```

## Files

| File | Purpose |
|------|---------|
| `SKILL.md` | Complete skill documentation |
| `backup-dna-dryrun.sh` | **Dry run** - preview backup without changes |
| `backup-dna-full.sh` | Full backup script |
| `restore-dna.sh` | Restore from backup |
| `validate-setup.sh` | Validate configuration |
| `check-upstream.sh` | Check for updates |
| `UPDATE_CHECKLIST.md` | Step-by-step update guide |
| `QUICK_REFERENCE.md` | Quick command reference |
| `METADATA.md` | Skill metadata and architecture |

## What Gets Backed Up

- ✅ Configuration (`~/.dna/dna.json`)
- ✅ Sessions state
- ✅ Agent states (multi-agent)
- ✅ Credentials & auth tokens
- ✅ Cron jobs
- ✅ Sandbox states
- ✅ **All agent workspaces (dynamically detected from config!)**
- ✅ Git repository state (commit, branch, remotes)

## Dynamic Workspace Detection

The scripts **automatically discover** all agent workspaces from your config:

```bash
# Reads from config:
.routing.agents.{agentId}.workspace

# Creates backups:
workspace-{agentId}.tar.gz
```

No hardcoded paths! Works with any agent configuration.

## Critical Changes in v2026.1.8

⚠️ **DM Lockdown**: DMs default to `pairing` (was open)  
⚠️ **Groups**: Now allowlists (add `"*"` for allow-all)  
⚠️ **Sandbox**: Default scope is `"agent"` (was `"session"`)  
⚠️ **Timestamps**: UTC format in envelopes  

## Backup Location

```
~/.dna-backups/pre-update-YYYYMMDD-HHMMSS/
├── dna.json
├── sessions.tar.gz
├── agents.tar.gz
├── credentials.tar.gz
├── cron.tar.gz
├── sandboxes.tar.gz
├── workspace-*.tar.gz       # Dynamically detected!
├── git-version.txt
├── git-status.txt
└── BACKUP_INFO.txt
```

## Usage Examples

### Before Major Update

```bash
# Full backup with validation
~/.skills/dna-update/backup-dna-full.sh

# Review what was backed up
ls -lh ~/.dna-backups/pre-update-*/
```

### After Update (if issues)

```bash
# Find latest backup
ls -t ~/.dna-backups/ | head -1

# Restore
~/.skills/dna-update/restore-dna.sh ~/.dna-backups/<dir>
```

### Check Backup Status

```bash
LATEST=$(ls -t ~/.dna-backups/ | head -1)
cat ~/.dna-backups/$LATEST/BACKUP_INFO.txt
```

## Testing After Update

```bash
# New CLI features
pnpm dna agents list
pnpm dna logs --tail 50
pnpm dna providers list --usage

# Web UI
open http://localhost:3001/logs

# Verify routing
# Send messages to your configured providers
```

## Installation

### Via ClawdHub (Recommended)

```bash
# Install from ClawdHub
clawdhub install dna-skill-update

# Make scripts executable (required after ClawdHub install)
chmod +x ~/.skills/dna-skill-update/*.sh
```

### Via Git

```bash
# Clone to your skills directory
git clone https://github.com/pasogott/dna-skill-update.git ~/.skills/dna-skill-update

# Make scripts executable
chmod +x ~/.skills/dna-skill-update/*.sh
```

### Quick Test

```bash
# Test with dry run
~/.skills/dna-skill-update/backup-dna-dryrun.sh
```

## Support

For issues, consult:
1. `UPDATE_CHECKLIST.md` for step-by-step guidance
2. `SKILL.md` for detailed troubleshooting
3. DNA logs: `pnpm dna logs --follow`
4. Run doctor: `pnpm dna doctor`

## License

MIT - see [LICENSE](LICENSE)

## Author

**Pascal Schott** ([@pasogott](https://github.com/pasogott))

Contribution for DNA  
Repository: https://github.com/dna/dna
