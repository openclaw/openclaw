# Jarvis Migration Guide: clawdbot → OpenClaw with DeepSeek

This guide details the migration of "Jarvis" (currently on Raspberry Pi 5) to OpenClaw with native DeepSeek API support on a tower PC server.

## What We've Accomplished

### 1. **DeepSeek Integration**

- Fixed DeepSeek provider visibility in OpenClaw onboarding wizard
- Updated package.json version to `2026.2.4 - datboi6942`
- Built OpenClaw with DeepSeek support
- Installed Node.js 22.22.0 via nvm (required by OpenClaw)

### 2. **Migration Toolkit Created**

- `scripts/migrate-tower-jarvis.sh` - Main migration script for tower PC
- `scripts/transfer-pi-backup.sh` - Transfer backup from Pi to tower
- `scripts/backup-pi-minimal.sh` - Minimal backup for Pi (safe when resources limited)
- `scripts/backup-pi-jarvis.sh` - Comprehensive Pi backup
- `scripts/rollback-pi-jarvis.sh` - Emergency rollback to clawdbot
- `scripts/migrate-pi-jarvis.sh` - Original Pi migration script (for reference)

### 3. **Environment Ready**

- OpenClaw repository cloned and built successfully
- Node.js 22.22.0 installed via nvm
- Build artifacts in `dist/` directory
- OpenClaw CLI functional with custom version

## Prerequisites

### Tower PC Requirements

- **Node.js 22+** (installed via nvm, already done)
- **DeepSeek API key** from https://platform.deepseak.com/api-keys
- **SSH access to Pi** (for backup transfer)
- **Approx 500MB free disk space**

### Pi Requirements

- **Pi must be rebooted** (currently hung due to backup process)
- **SSH enabled** and accessible via network
- **Existing clawdbot installation** at `/home/john/.clawdbot`
- **Jarvis workspace** at `/home/john/clawd`

## Migration Steps

### Step 1: Reboot Pi

The Pi is currently unresponsive (hung backup process for 2+ hours). Physically power cycle the Pi:

1. Unplug power cable from Pi
2. Wait 10 seconds
3. Plug power back in
4. Wait 2 minutes for boot

### Step 2: Create Backup on Pi

SSH into Pi (replace `raspberrypi.local` with actual IP if needed):

```bash
ssh john@raspberrypi.local
cd openclaw
bash scripts/backup-pi-minimal.sh
```

Note the backup directory (e.g., `/tmp/jarvis-minimal-backup-YYYYMMDD-HHMMSS`)

### Step 3: Transfer Backup to Tower PC

On tower PC, run the transfer script:

```bash
cd openclaw
bash scripts/transfer-pi-backup.sh
```

Or manually copy with scp:

```bash
scp -r john@raspberrypi.local:/tmp/jarvis-minimal-backup-* /tmp/
```

### Step 4: Run Migration on Tower PC

With DeepSeek API key ready:

```bash
cd openclaw
bash scripts/migrate-tower-jarvis.sh \
  --backup "/tmp/jarvis-minimal-backup-YYYYMMDD-HHMMSS" \
  --deepseek-key "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

### Step 5: Verify Migration

```bash
# Check OpenClaw version
openclaw --version

# Check DeepSeek provider
openclaw models status | grep -i deepseek

# Test workspace
ls -la ~/clawd/

# Start gateway
openclaw gateway run --daemon
```

## Critical Files to Preserve

### Workspace (Jarvis Personality)

- `~/clawd/SOUL.md` - Core identity
- `~/clawd/AGENTS.md` - Agent configurations
- `~/clawd/TOOLS.md` - Tool definitions
- `~/clawd/IDENTITY.md` - Identity settings
- `~/clawd/USER.md` - User preferences
- `~/clawd/HEARTBEAT.md` - Heartbeat configuration
- `~/clawd/MEMORY.md` - Memory database reference

### Configuration

- `~/.clawdbot/clawdbot.json` - Main configuration
- `~/.clawdbot/.env` - Environment variables
- `~/.clawdbot/memory/lancedb/` - Memory database (optional)

## DeepSeek Configuration

After migration, ensure DeepSeek is properly configured:

1. **Set API key** (if not already set):

   ```bash
   export DEEPSEEK_API_KEY="sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
   echo "export DEEPSEEK_API_KEY='$DEEPSEEK_API_KEY'" >> ~/.openclaw/.env
   ```

2. **Configure provider**:

   ```bash
   openclaw configure --auth-choice deepseek-api-key
   ```

3. **Verify provider appears** in `openclaw models status`

## Rollback Procedure

If migration fails, rollback to clawdbot:

1. **Stop OpenClaw services**:

   ```bash
   pkill -f openclaw
   ```

2. **Run rollback script**:

   ```bash
   cd openclaw
   bash scripts/rollback-pi-jarvis.sh
   ```

3. **Reinstall clawdbot** (if needed):
   ```bash
   npm install -g clawdbot
   ```

## Troubleshooting

### Node.js Version Issues

- OpenClaw requires Node.js ≥22.12.0
- We installed Node.js 22.22.0 via nvm
- Ensure nvm is loaded: `source ~/.nvm/nvm.sh`
- Verify: `node --version` shows `v22.22.0`

### DeepSeek Not Appearing

- Rebuild OpenClaw: `npx pnpm build`
- Check source fix in `src/commands/auth-choice-options.ts`
- Run verification: `node scripts/verify-deepseek.js`

### Pi SSH Issues

- Ensure Pi is on same network
- Try IP address instead of hostname
- Check SSH keys: `ssh-copy-id john@raspberrypi.local`

### Backup Transfer Failures

- Use manual scp transfer
- Check disk space on tower PC
- Verify Pi backup directory exists

## Script Reference

### `migrate-tower-jarvis.sh`

Main migration script for tower PC. Options:

- `-b, --backup DIR` - Source backup directory
- `-k, --deepseek-key KEY` - DeepSeek API key
- `-h, --help` - Show help

### `transfer-pi-backup.sh`

Transfer backup from Pi to tower. Automates SSH connection and file transfer.

### `backup-pi-minimal.sh`

Minimal backup script for Pi. Only backs up critical files.

### `rollback-pi-jarvis.sh`

Rollback to clawdbot. Restores from backup and reinstalls clawdbot.

## Post-Migration Tasks

1. **Test Jarvis functionality**:

   ```bash
   openclaw message send --channel whatsapp --to "+1234567890" --text "Hello from the new Jarvis!"
   ```

2. **Monitor logs**:

   ```bash
   tail -f /tmp/openclaw-gateway.log
   ```

3. **Set up automation** (systemd service):

   ```bash
   openclaw gateway install-service
   ```

4. **Update configuration** as needed via `openclaw configure`

## Support

- OpenClaw documentation: https://docs.openclaw.ai
- DeepSeek API: https://platform.deepseek.com/api-keys
- Issues: https://github.com/datboi6942/openclaw/issues

---

**Migration Status**: Ready for execution  
**Last Updated**: $(date +%Y-%m-%d)  
**Version**: 2026.2.4 - datboi6942  
**Node.js**: $(node --version)  
**OpenClaw**: $(node openclaw.mjs --version)
