# DNA Update to v2026.1.8 - Checklist

## ✅ Pre-Update Checklist

- [ ] **Backup created**: `/tmp/backup-dna-full.sh`
- [ ] **Gateway stopped**: `pnpm dna gateway stop`
- [ ] **Backup validated**: All important files present
- [ ] **Time window**: 45-60 minutes planned

## 📦 Backup Locations

```bash
# Backup Script
~/.skills/dna-update/backup-dna-full.sh

# Restore Script
~/.skills/dna-update/restore-dna.sh

# Backup will be saved in:
~/.dna-backups/pre-update-YYYYMMDD-HHMMSS/
```

## 🚀 Update Steps

### 1. Backup (10 min)
```bash
~/.skills/dna-update/backup-dna-dryrun.sh  # Dry run first
~/.skills/dna-update/backup-dna-full.sh
```

### 2. Update Code (5 min)
```bash
cd ~/code/dna  # Or your dna path
git checkout main
git pull --rebase origin main
pnpm install
pnpm build
```

### 3. Config Adjustments (10 min)

#### A) WhatsApp/Telegram dmPolicy (CRITICAL!)
```bash
# Check current policy
jq '.whatsapp.dmPolicy, .telegram.dmPolicy' ~/.dna/dna.json

# Option 1: Use pairing (recommended for security)
jq '.whatsapp.dmPolicy = "pairing" | .telegram.dmPolicy = "pairing"' ~/.dna/dna.json > /tmp/temp.json
mv /tmp/temp.json ~/.dna/dna.json

# Option 2: Keep allowlist (verify your allowFrom list!)
jq '.whatsapp.allowFrom, .telegram.allowFrom' ~/.dna/dna.json
```

#### B) Sandbox Scope (set explicitly)
```bash
jq '.agent.sandbox.scope = "agent"' ~/.dna/dna.json > /tmp/temp.json
mv /tmp/temp.json ~/.dna/dna.json
```

#### C) User Timezone (optional)
```bash
# Set your timezone for better timestamps
jq '.agent.userTimezone = "America/New_York"' ~/.dna/dna.json > /tmp/temp.json
mv /tmp/temp.json ~/.dna/dna.json
```

### 4. Doctor (5 min)
```bash
cd ~/code/dna
pnpm dna gateway start  # Foreground
# New terminal:
pnpm dna doctor --yes
```

### 5. Tests (10 min)

#### Provider Tests
- [ ] Test DM to bot → Works with pairing
- [ ] Test group mentions → Bot responds
- [ ] Test media upload → Works

#### Multi-Agent (if configured)
- [ ] Agent routing works correctly
- [ ] Sandbox isolation works
- [ ] Tool restrictions work

#### New Features
- [ ] `pnpm dna agents list`
- [ ] `pnpm dna logs --tail 50`
- [ ] `pnpm dna providers list --usage`
- [ ] Web UI Logs Tab: http://localhost:3001/logs

### 6. Production (5 min)
```bash
# Gateway as daemon
pnpm dna gateway stop  # If foreground
pnpm dna gateway start --daemon
pnpm dna gateway status
```

## 🆘 Rollback

```bash
# Restore Script
~/.skills/dna-update/restore-dna.sh ~/.dna-backups/pre-update-YYYYMMDD-HHMMSS

# Or manually:
cd ~/code/dna
git checkout <old-commit>
pnpm install && pnpm build
cp ~/.dna-backups/pre-update-*/dna.json ~/.dna/
pnpm dna gateway restart
```

## ⚠️ Breaking Changes Check

- [ ] **DM Policy**: Check pairing vs allowlist
- [ ] **Groups**: Verify allowlists (add `"*"` for all)
- [ ] **Sandbox**: Scope explicitly set
- [ ] **Timestamps**: Check if custom parsing needed
- [ ] **Slash Commands**: Authorization works
- [ ] **Model Config**: Doctor migrated

## 📊 Monitoring (24h)

### Logs
```bash
pnpm dna logs --follow
# Or: Web UI → http://localhost:3001/logs
```

### Status
```bash
pnpm dna status
pnpm dna providers list --usage
pnpm dna agents list
```

### Watch For
- [ ] No auth errors in logs
- [ ] Typing indicators work (not stuck)
- [ ] Sandbox containers run
- [ ] Sessions route correctly

## 📝 Configuration Examples

### Multi-Agent Example
```json
{
  "routing": {
    "agents": {
      "main": {
        "name": "Main Assistant",
        "workspace": "~/clawd"
      },
      "work": {
        "name": "Work Assistant",
        "workspace": "~/clawd-work",
        "sandbox": {
          "mode": "all",
          "scope": "agent"
        }
      }
    }
  }
}
```

### Provider DM Policies
```json
{
  "telegram": {
    "dmPolicy": "pairing"
  },
  "whatsapp": {
    "dmPolicy": "allowlist",
    "allowFrom": ["+1234567890", "+9876543210"]
  }
}
```

## 🎯 Success Criteria

✅ Gateway runs stable  
✅ Provider DMs + Groups work  
✅ Multi-Agent routing works (if configured)  
✅ Sandbox isolation works (if configured)  
✅ No auth errors  
✅ No stuck typing indicators  
✅ New CLI tools work  

## 📞 If Problems

1. **Logs**: `pnpm dna logs --grep error`
2. **Doctor**: `pnpm dna doctor`
3. **Restart**: `pnpm dna gateway restart`
4. **Rollback**: Use restore script with backup directory

---

**Backup Location**: `~/.dna-backups/pre-update-*`  
**Update Date**: $(date)  
**Target Version**: v2026.1.8  
**Estimated Time**: 45-60 minutes
