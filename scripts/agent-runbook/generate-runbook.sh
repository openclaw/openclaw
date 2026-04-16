#!/usr/bin/env bash
# Agent Runbook Generator
# Extracts recent failures and commands from logs, summarizes them into
# markdown sections, and writes an Obsidian-compatible runbook.
#
# Usage: ./generate-runbook.sh [--output PATH] [--vault PATH]
#
# --output  Output file path (default: ./agent-runbook.md)
# --vault   Obsidian vault root for wiki links (default: auto-detect)
#
# Task ID: 7202d396-9b3f-4228-b870-99ffbd53c0ad

set -euo pipefail

OUTPUT="${OUTPUT:-./agent-runbook.md}"
VAULT_ROOT=""
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
WORKSPACE="${OPENCLAW_HOME}/workspace"

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --output)  OUTPUT="$2"; shift 2 ;;
    --vault)   VAULT_ROOT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Auto-detect vault
if [[ -z "$VAULT_ROOT" ]]; then
  if [[ -d "$HOME/SakVault" ]]; then
    VAULT_ROOT="$HOME/SakVault"
  elif [[ -d "/mnt/c/Users/Sak/Google Drive/SakVault" ]]; then
    VAULT_ROOT="/mnt/c/Users/Sak/Google Drive/SakVault"
  else
    VAULT_ROOT="$WORKSPACE"
  fi
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ── Collect data ──────────────────────────────────────────────

# OpenClaw command log entries (session resets, errors)
cmd_log="$OPENCLAW_HOME/logs/commands.log"
cmd_summary=""
if [[ -f "$cmd_log" ]]; then
  total=$(wc -l < "$cmd_log" 2>/dev/null || echo 0)
  resets=$(grep -c '"action":"reset"' "$cmd_log" 2>/dev/null || echo 0)
  news=$(grep -c '"action":"new"' "$cmd_log" 2>/dev/null || echo 0)
  cmd_summary="| Metric | Count |
|--------|-------|
| Total entries | ${total} |
| New sessions | ${news} |
| Session resets | ${resets} |"
fi

# Config health
config_health="$OPENCLAW_HOME/logs/config-health.json"
config_section=""
if [[ -f "$config_health" ]]; then
  config_section="\`\`\`json
$(cat "$config_health")
\`\`\`"
fi

# Mission Control DB size
mc_db="$WORKSPACE/mission-control/mission-control.db"
mc_db_info=""
if [[ -f "$mc_db" ]]; then
  mc_size=$(du -h "$mc_db" | cut -f1)
  mc_db_info="Mission Control DB: ${mc_size}"
fi

# Collector services status
collector_section=""
if command -v systemctl &>/dev/null; then
  krain88_status=$(systemctl is-active krain88-collector 2>/dev/null || echo "unknown")
  collector_section="| Service | Status |
|---------|--------|
| krain88-collector | ${krain88_status} |"
else
  # WSL fallback — check for running processes
  krain88_pid=$(pgrep -f "monitor.py" 2>/dev/null || echo "not running")
  if [[ "$krain88_pid" != "not running" ]]; then
    collector_section="| Service | Status |
|---------|--------|
| krain88-collector | running (PID ${krain88_pid}) |"
  else
    collector_section="| Service | Status |
|---------|--------|
| krain88-collector | not running |"
  fi
fi

# Cron jobs
cron_section=""
if [[ -d "$OPENCLAW_HOME/cron" ]]; then
  cron_count=$(find "$OPENCLAW_HOME/cron" -name "*.json" 2>/dev/null | wc -l)
  cron_section="${cron_count} cron jobs registered"
fi

# Recent errors from Krain88 data (if available)
krain88_errors=""
krain88_data="$WORKSPACE/krain88/data"
if [[ -d "$krain88_data" ]]; then
  # Check for any error logs
  error_files=$(find "$krain88_data" -name "*.log" -o -name "error*" 2>/dev/null | head -5)
  if [[ -n "$error_files" ]]; then
    krain88_errors="Recent error files found:\n"
    for f in $error_files; do
      krain88_errors+="  - \`$(basename "$f")\`\n"
    done
  else
    krain88_errors="No error logs found in data directory."
  fi
fi

# ── Generate Runbook ──────────────────────────────────────────

cat > "$OUTPUT" <<RUNBOOK
# Agent Runbook

_Generated: ${TIMESTAMP}_
_Auto-refresh schedule: daily via cron_

---

## 1. Common Agent Tasks

### OpenClaw Gateway

| Task | Command |
|------|---------|
| Check status | \`openclaw gateway status\` |
| Start gateway | \`openclaw gateway start\` |
| Stop gateway | \`openclaw gateway stop\` |
| Restart gateway | \`openclaw gateway restart\` |
| Check version | \`openclaw --version\` |
| Full status | \`openclaw status\` |

### Session Management

| Task | Command |
|------|---------|
| Reset current session | \`/reset\` |
| New session | \`/new\` |
| Toggle reasoning | \`/reasoning\` |
| Show status | \`/status\` |

### Memory & Vault

| Task | Command |
|------|---------|
| Search memory | \`memory_search("query")\` |
| Read vault note | \`memory_get("path")\` |
| Wiki status | Read \`SakVault/wiki-status.md\` |

### Cron Jobs

| Task | Command |
|------|---------|
| List cron jobs | \`cron(action="list")\` |
| Check scheduler | \`cron(action="status")\` |

---

## 2. Collector Services

${collector_section}

### Krain88 Collector

| Task | Command |
|------|---------|
| Run manually | \`cd ~/workspace/krain88 && .venv/bin/python3 monitor.py\` |
| Run quietly | \`cd ~/workspace/krain88 && .venv/bin/python3 monitor.py --quiet\` |
| Backup DB | \`cd ~/workspace/krain88 && ./backup_db.sh\` |
| Export research | \`cd ~/workspace/krain88 && ./export_research.sh\` |
| Check service | \`systemctl status krain88-collector\` (or \`pgrep -f monitor.py\` on WSL) |
| Restart service | \`sudo systemctl restart krain88-collector\` |

**Known Pitfalls:**
- WSL cannot use systemd services directly; use the Python command or \`service.sh\`
- Collector requires \`.env\` with valid API keys
- Virtual environment must be at \`.venv/\` inside the krain88 directory

${mc_db_info}

---

## 3. Mission Control

| Task | Command |
|------|---------|
| Start | \`cd ~/workspace/mission-control && ./start.sh\` |
| Check health | \`curl http://localhost:3000/api/health\` |
| View DB | SQLite browser on \`mission-control.db\` |

**Known Pitfalls:**
- DB WAL file can grow large; run backup periodically
- \`.env.local\` must be configured before first run
- Next.js build cache (\.next/\) can get stale; clear and rebuild if UI issues

---

## 4. Recent Activity Summary

${cmd_summary}

### Config Health

${config_section}

### Cron Status

${cron_section}

---

## 5. Troubleshooting

### Gateway Won't Start
1. Check port availability: \`lsof -i :4000\`
2. Verify config: \`cat ~/.openclaw/openclaw.json\`
3. Check logs: \`tail -50 ~/.openclaw/logs/commands.log\`
4. Try: \`openclaw gateway stop && openclaw gateway start\`

### Collector Not Running
1. Check process: \`pgrep -f monitor.py\`
2. Check logs in krain88/data/ for errors
3. Verify .env has required API keys
4. Restart: \`cd ~/workspace/krain88 && .venv/bin/python3 monitor.py --quiet\`

### Mission Control DB Issues
1. Check DB size: \`du -h ~/workspace/mission-control/mission-control.db*\`
2. Run backup: \`cd ~/workspace/mission-control/db-backups\`
3. If WAL is huge, checkpoint: \`sqlite3 mission-control.db "PRAGMA wal_checkpoint(TRUNCATE);"\`

### Telegram/Discord Not Responding
1. Check channel config in \`openclaw.json\`
2. Verify bot tokens in credentials
3. Restart gateway after config changes

### Memory/Vault Symlink Broken
1. Check: \`ls -la ~/SakVault\`
2. Verify Google Drive mount if using Drive sync
3. Alert Dad if unresolvable — vault integrity is critical

---

## 6. Obsidian Wiki Links

| Domain | Path | Notes |
|--------|------|-------|
| Krain88 | \`SakVault/Krain88/\` | [[Krain88/index\|Krain88 Wiki]] |
| SoCandyShop | \`SakVault/SoCandyShop/\` | [[SoCandyShop/index\|SoCandyShop Wiki]] |
| GPU-Deal-Hunter | \`SakVault/GPU-Deal-Hunter/\` | [[GPU-Deal-Hunter/index\|GPU Deal Hunter Wiki]] |
| Phnom-Penh-Rain | \`SakVault/Phnom-Penh-Rain/\` | [[Phnom-Penh-Rain/index\|Rain Wiki]] |
| OpenClaw-Setup | \`SakVault/OpenClaw-Setup/\` | [[OpenClaw-Setup/index\|OpenClaw Setup Wiki]] |
| Agent-Shared | \`SakVault/Agent-Shared/\` | [[Agent-Shared/user-profile\|User Profile]] |

---

## 7. Krain88 Error Status

${krain88_errors:-No Krain88 data directory found.}

---

_Last refreshed: ${TIMESTAMP}_
_Next refresh: scheduled via OpenClaw cron (daily)_
RUNBOOK

echo "Runbook generated: ${OUTPUT}"
