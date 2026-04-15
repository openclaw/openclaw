---
title: "DR Drills"
summary: "Backup and restore procedures, disaster recovery drills, chaos runbooks, and recovery time targets"
read_when:
  - Running a quarterly DR drill
  - Recovering from data loss or a corrupted deployment
  - Understanding what state needs to be backed up and how
---

# DR Drills

## Recovery objectives

| Scenario | RTO (recovery time objective) | RPO (recovery point objective) |
|---|---|---|
| Gateway restart (process crash) | ≤ 1 min | 0 (stateless process; state on disk) |
| Config corruption | ≤ 15 min | Last backup (daily recommended) |
| Session/memory data loss | ≤ 30 min restore from backup | Last backup (daily recommended) |
| Credential loss | ≤ 2 h (re-link channels) | N/A (not backed up; regenerated) |
| Full host failure | ≤ 4 h | Last backup (daily recommended) |
| Bad npm release rollback | ≤ 30 min | N/A |

---

## State inventory

These are the critical state items that must be backed up.

| Path | Contents | Backup frequency |
|---|---|---|
| `~/.openclaw/openclaw.json` | Main config | Daily |
| `~/.openclaw/agents/*/sessions/` | Session transcripts and memory | Daily |
| `~/.openclaw/agents/*/sessions/*.jsonl` | Pi session logs | Daily |
| `~/.openclaw/credentials/` | Channel auth credentials | Daily (encrypted) |
| `~/.openclaw/state/` | Pairing state, plugin state | Daily |

> **Important:** Credential files contain sensitive tokens. Always encrypt backups
> at rest. Never commit or expose credential directories.

---

## Backup procedure (standard)

```bash
#!/usr/bin/env bash
# scripts/openclaw-backup.sh — run daily via cron or launchd
set -euo pipefail

BACKUP_DIR="${HOME}/.openclaw-backups"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
BACKUP_PATH="${BACKUP_DIR}/${TIMESTAMP}"

mkdir -p "${BACKUP_PATH}"

# Config
cp ~/.openclaw/openclaw.json "${BACKUP_PATH}/openclaw.json"

# Sessions and memory (exclude large binary attachments)
rsync -a --exclude='*.bin' --exclude='attachments/' \
  ~/.openclaw/agents/ "${BACKUP_PATH}/agents/"

# State (skip credentials — back up separately with encryption)
rsync -a --exclude='credentials/' \
  ~/.openclaw/state/ "${BACKUP_PATH}/state/" 2>/dev/null || true

# Encrypted credentials backup (requires gpg key configured)
# tar -czf - ~/.openclaw/credentials/ | gpg --encrypt --recipient your@email.com \
#   > "${BACKUP_PATH}/credentials.tar.gz.gpg"

# Rotate: keep last 14 backups
ls -dt "${BACKUP_DIR}"/20* | tail -n +15 | xargs -r rm -rf

echo "Backup complete: ${BACKUP_PATH}"
```

---

## Restore procedure

```bash
#!/usr/bin/env bash
# Restore from a specific backup
set -euo pipefail

BACKUP_PATH="$1"   # e.g., ~/.openclaw-backups/20260415T120000Z

if [ -z "${BACKUP_PATH}" ]; then
  echo "Usage: openclaw-restore.sh <backup-path>"
  exit 1
fi

# Stop gateway before restore
pkill -f openclaw-gateway || true
sleep 2

# Restore config
cp "${BACKUP_PATH}/openclaw.json" ~/.openclaw/openclaw.json

# Restore agents/sessions
rsync -a "${BACKUP_PATH}/agents/" ~/.openclaw/agents/

# Restore state
rsync -a "${BACKUP_PATH}/state/" ~/.openclaw/state/ 2>/dev/null || true

# Credentials: decrypt and restore manually
# gpg --decrypt "${BACKUP_PATH}/credentials.tar.gz.gpg" | tar -xzf - -C ~/.openclaw/

echo "Restore complete. Run 'openclaw doctor --repair' before restarting."
```

After restore, always run:

```bash
openclaw doctor --repair
openclaw health --verbose
```

---

## DR drills catalog

Run at least one drill per quarterly resilience review (see [Ops Review Cadence](./ops-review.md)).

### Drill DR-01: Gateway crash recovery

**Target RTO:** 1 min

1. Simulate a hard crash (SIGKILL, intentional for this drill):

   ```bash
   pkill -9 -f openclaw-gateway
   ```

2. Verify it is down:

   ```bash
   openclaw health  # should fail or time out
   ```

3. Restart via standard method (supervisor, launchd, systemd):

   ```bash
   bash scripts/restart-mac.sh   # macOS
   # or systemctl --user restart openclaw-gateway
   ```

4. Measure time to `openclaw health --verbose` returning `ok: true`.
5. Record: RTO achieved, any issues found.

**Pass criteria:** Gateway healthy within 1 min; no data loss.

---

### Drill DR-02: Config restore

**Target RTO:** 15 min

1. Corrupt the config file:

   ```bash
   cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.drill-backup
   echo "CORRUPTED" > ~/.openclaw/openclaw.json
   ```

2. Attempt gateway start — expect failure:

   ```bash
   openclaw gateway run --port 18789 2>&1 | head -20
   ```

3. Restore from most recent backup:

   ```bash
   cp <most-recent-backup>/openclaw.json ~/.openclaw/openclaw.json
   # or restore original
   cp ~/.openclaw/openclaw.json.drill-backup ~/.openclaw/openclaw.json
   ```

4. Run doctor and restart:

   ```bash
   openclaw doctor --repair
   openclaw gateway run --port 18789
   ```

5. Measure total time from step 1 to healthy gateway.
6. Cleanup: `rm ~/.openclaw/openclaw.json.drill-backup`

**Pass criteria:** Gateway healthy within 15 min; config validated by doctor.

---

### Drill DR-03: Session data restore

**Target RTO:** 30 min

1. Note current session count:

   ```bash
   openclaw sessions list --limit 5
   ```

2. Remove a session directory (simulate partial data loss):

   ```bash
   AGENT_DIR=$(ls ~/.openclaw/agents/ | head -1)
   mv ~/.openclaw/agents/${AGENT_DIR}/sessions \
      ~/.openclaw/agents/${AGENT_DIR}/sessions.drill-backup
   ```

3. Verify sessions are missing:

   ```bash
   openclaw sessions list   # should show empty or error
   ```

4. Restore from backup:

   ```bash
   mv ~/.openclaw/agents/${AGENT_DIR}/sessions.drill-backup \
      ~/.openclaw/agents/${AGENT_DIR}/sessions
   ```

5. Verify restoration:

   ```bash
   openclaw sessions list --limit 5
   ```

6. Measure total time.

**Pass criteria:** Sessions restored within 30 min; no corruption detected.

---

### Drill DR-04: npm release rollback

**Target RTO:** 30 min (release managers only)

1. Identify the previous stable version:

   ```bash
   npm view openclaw versions --json | node -e "const v=require('fs').readFileSync('/dev/stdin','utf8'); console.log(JSON.parse(v).slice(-5).join('\n'))"
   ```

2. Simulate rollback (dry run — do not run against real registry):

   ```bash
   echo "Would run: npm dist-tag add openclaw@<prev-version> latest"
   ```

3. Verify post-rollback smoke would pass:

   ```bash
   node --import tsx scripts/openclaw-npm-postpublish-verify.ts <prev-version>
   ```

4. Record: rollback process familiarity, any gaps in runbook.

---

## Drill results log

Record each drill run in the private maintainer docs or GitHub Discussions (Postmortems category).

| Date | Drill | Operator | RTO achieved | Pass/Fail | Issues found |
|---|---|---|---|---|---|
| YYYY-MM-DD | DR-01 | @handle | X min | Pass/Fail | Notes |
| YYYY-MM-DD | DR-02 | @handle | X min | Pass/Fail | Notes |

---

## Chaos runbook (advanced)

For teams running shared or multi-agent deployments:

- **Simulate slow model response:** set `agents.defaults.timeout` to 5s and verify
  graceful fallback behavior.
- **Simulate channel failure:** restart a channel with invalid credentials and verify
  health monitor detects and alerts within `channelHealthCheckMinutes`.
- **Simulate memory pressure:** run `OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test` and verify
  tests still pass under constrained memory.
- **Simulate expired auth:** rotate the gateway bearer secret and verify session
  re-authentication works correctly.
