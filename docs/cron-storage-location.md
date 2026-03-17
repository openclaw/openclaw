# Cron Job Storage Location

## 📍 Cron Jobs Được Lưu Ở Đâu?

### **Default Location (Mặc định):**

```
~/.openclaw/cron/jobs.json
```

**Full path:**

```
/Users/<username>/.openclaw/cron/jobs.json
```

### **Environment Variables (Biến môi trường):**

Có thể override location bằng:

```bash
# Primary
export OPENCLAW_STATE_DIR=/custom/path
# Legacy support
export CLAWDBOT_STATE_DIR=/custom/path
```

Khi đó cron store sẽ ở:

```
$OPENCLAW_STATE_DIR/cron/jobs.json
```

## 📁 File Structure

### **File:** `~/.openclaw/cron/jobs.json`

```json
{
  "version": 1,
  "jobs": [
    {
      "id": "unique-job-id",
      "name": "Job Name",
      "description": "Optional description",
      "enabled": true,
      "schedule": {
        "kind": "cron",
        "expr": "0 * * * *",
        "tz": "UTC",
        "staggerMs": 0
      },
      "sessionTarget": "isolated",
      "wakeMode": "now",
      "payload": {
        "kind": "agentTurn",
        "message": "Your prompt here"
      },
      "delivery": {
        "mode": "announce",
        "channel": "telegram",
        "to": "@channel",
        "bestEffort": false
      },
      "failureAlert": {
        "after": 2,
        "channel": "telegram",
        "to": "@admin",
        "mode": "announce"
      },
      "agentId": "main",
      "sessionKey": "agent:main:main",
      "deleteAfterRun": false,
      "createdAtMs": 1773719902534,
      "updatedAtMs": 1773719902534,
      "state": {
        "nextRunAtMs": 1773720200000,
        "runningAtMs": null,
        "lastRunAtMs": 1773719900000,
        "lastRunStatus": "ok",
        "lastDurationMs": 5432,
        "consecutiveErrors": 0
      }
    }
  ]
}
```

## 🔍 Kiểm Tra Cron Jobs

### **1. Xem qua CLI:**

```bash
# List all cron jobs
openclaw cron list

# List with details
openclaw cron list --include-disabled

# View specific job
openclaw cron list | jq '.[] | select(.id == "job-id")'

# View cron status
openclaw cron status
```

### **2. Xem file trực tiếp:**

```bash
# View file
cat ~/.openclaw/cron/jobs.json

# Pretty print
cat ~/.openclaw/cron/jobs.json | jq '.'

# View file info
ls -lh ~/.openclaw/cron/jobs.json

# Watch file changes
watch -n 2 'cat ~/.openclaw/cron/jobs.json | jq ".jobs | length"'
```

### **3. Check location trong code:**

```bash
# Check actual path used
node -e "
const path = require('path');
const home = process.env.HOME || process.env.USERPROFILE;
console.log('Default cron store path:', path.join(home, '.openclaw', 'cron', 'jobs.json'));
console.log('Custom path (if OPENCLAW_STATE_DIR set):',
  process.env.OPENCLAW_STATE_DIR
    ? path.join(process.env.OPENCLAW_STATE_DIR, 'cron', 'jobs.json')
    : 'Not set');
"
```

## 📂 Directory Structure

```
~/.openclaw/
├── cron/
│   ├── jobs.json              # Cron jobs store
│   └── runs/                  # Run logs
│       ├── job-id-1.jsonl
│       ├── job-id-2.jsonl
│       └── ...
├── agents/
│   ├── main/
│   │   ├── sessions/
│   │   │   └── sessions.json  # Session store
│   │   └── transcripts/
│   └── ...
├── logs/
│   └── gateway.log
└── openclaw.json              # Main config
```

## 🗂️ Related Files

### **Cron Store:**

- **Path:** `~/.openclaw/cron/jobs.json`
- **Purpose:** Lưu trữ tất cả cron jobs
- **Format:** JSON với versioning

### **Run Logs:**

- **Path:** `~/.openclaw/cron/runs/<job-id>.jsonl`
- **Purpose:** Log mỗi lần job chạy
- **Format:** JSONL (mỗi line là một JSON object)

### **Session Store:**

- **Path:** `~/.openclaw/agents/<agent-id>/sessions/sessions.json`
- **Purpose:** Lưu sessions của agents (bao gồm cron sessions)
- **Format:** JSON map (sessionKey -> SessionEntry)

## 🔧 Code References

### **File:** `src/cron/store.ts`

```typescript
export const DEFAULT_CRON_DIR = path.join(CONFIG_DIR, "cron");
export const DEFAULT_CRON_STORE_PATH = path.join(DEFAULT_CRON_DIR, "jobs.json");

export function resolveCronStorePath(storePath?: string) {
  if (storePath?.trim()) {
    const raw = storePath.trim();
    if (raw.startsWith("~")) {
      return path.resolve(expandHomePrefix(raw));
    }
    return path.resolve(raw);
  }
  return DEFAULT_CRON_STORE_PATH; // ~/.openclaw/cron/jobs.json
}
```

### **File:** `src/config/paths.ts`

```typescript
const NEW_STATE_DIRNAME = ".openclaw";

function newStateDir(homedir: () => string): string {
  return path.join(homedir(), NEW_STATE_DIRNAME);
}

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env);
  }
  return newStateDir(homedir); // ~/.openclaw
}
```

### **File:** `src/cron/service/store.ts`

```typescript
export async function ensureLoaded(state: CronServiceState, opts?) {
  // Load from file: state.deps.storePath
  const loaded = await loadCronStore(state.deps.storePath);

  // state.deps.storePath defaults to ~/.openclaw/cron/jobs.json
  state.store = { version: 1, jobs: loaded.jobs };

  // Persist changes
  await persist(state); // Saves to state.deps.storePath
}
```

## 📝 Workflow Cron Jobs

Workflow cron jobs được lưu cùng chỗ, với description chứa workflow chain:

```json
{
  "id": "workflow-job-id",
  "name": "Workflow: test wroflow",
  "description": "__wf_chain__:[{\"nodeId\":\"2\",\"actionType\":\"agent-prompt\",\"prompt\":\"Phân tích dự án...\"},{\"nodeId\":\"dndnode_0\",\"actionType\":\"agent-prompt\",\"prompt\":\"Lên kế hoạch...\"}]",
  "schedule": {
    "kind": "cron",
    "expr": "* 8 * * *"
  },
  "sessionTarget": "reuse",
  "payload": {
    "kind": "agentTurn",
    "message": "Ping from Workflow"
  }
}
```

## 🔐 Backup & Restore

### **Backup:**

```bash
# Backup cron jobs
cp ~/.openclaw/cron/jobs.json ~/.openclaw/cron/jobs.json.bak.$(date +%Y%m%d-%H%M%S)

# Backup all cron data
tar -czf openclaw-cron-backup.tar.gz ~/.openclaw/cron/
```

### **Restore:**

```bash
# Restore from backup
cp ~/.openclaw/cron/jobs.json.bak.20260317-120000 ~/.openclaw/cron/jobs.json

# Or from tarball
tar -xzf openclaw-cron-backup.tar.gz -C ~/
```

### **Auto-backup:**

File tự động backup khi update (xem `src/cron/store.ts`):

```typescript
await fs.promises.copyFile(storePath, `${storePath}.bak`);
```

## 🧪 Testing

### **Test với custom path:**

```bash
# Create test directory
mkdir -p /tmp/test-cron

# Set environment
export OPENCLAW_STATE_DIR=/tmp/test-cron

# Verify path
node -e "console.log('Cron store:', process.env.OPENCLAW_STATE_DIR + '/cron/jobs.json')"

# Run gateway
openclaw gateway run

# Check files
ls -la /tmp/test-cron/cron/
```

### **Test file format:**

```bash
# Create minimal test file
cat > /tmp/test-jobs.json << 'EOF'
{
  "version": 1,
  "jobs": [
    {
      "id": "test-1",
      "name": "Test Job",
      "enabled": true,
      "schedule": { "kind": "cron", "expr": "* * * * *" },
      "sessionTarget": "isolated",
      "wakeMode": "now",
      "payload": { "kind": "agentTurn", "message": "Test" },
      "delivery": { "mode": "none" },
      "state": {}
    }
  ]
}
EOF

# Validate JSON
cat /tmp/test-jobs.json | jq '.'

# Load in test
pnpm test src/cron/store.test.ts
```

## 📊 Storage Details

### **File Size:**

- **Default max:** Unlimited (JSON file)
- **Typical size:** < 100KB cho < 100 jobs
- **Auto-backup:** `.bak` file created on updates

### **Run Logs:**

- **Location:** `~/.openclaw/cron/runs/<job-id>.jsonl`
- **Max size:** 2MB per job (configurable)
- **Keep lines:** 2000 lines (configurable)
- **Format:** JSONL (append-only)

### **Config Options:**

```json
{
  "cron": {
    "runLog": {
      "maxBytes": "2MB",
      "keepLines": 2000
    }
  }
}
```

## 🎯 Quick Commands

```bash
# Where is cron store?
echo ~/.openclaw/cron/jobs.json

# How many jobs?
cat ~/.openclaw/cron/jobs.json | jq '.jobs | length'

# Show all job IDs
cat ~/.openclaw/cron/jobs.json | jq '.jobs[].id'

# Show job names
cat ~/.openclaw/cron/jobs.json | jq '.jobs[].name'

# Find workflow jobs
cat ~/.openclaw/cron/jobs.json | jq '.jobs[] | select(.description | contains("__wf_chain__"))'

# Check last run times
cat ~/.openclaw/cron/jobs.json | jq '.jobs[] | {id, name, lastRun: .state.lastRunAtMs, nextRun: .state.nextRunAtMs}'

# View run logs
cat ~/.openclaw/cron/runs/*.jsonl | jq -s '.[-5:]'
```

## 🔗 Related Documentation

- **Cron Service:** `src/cron/service.ts`
- **Cron Store:** `src/cron/store.ts`
- **Cron Types:** `src/cron/types.ts`
- **Paths Config:** `src/config/paths.ts`
- **Run Logs:** `src/cron/run-log.ts`

## ✅ Summary

| Component           | Location                                      | Format |
| ------------------- | --------------------------------------------- | ------ |
| **Cron Jobs**       | `~/.openclaw/cron/jobs.json`                  | JSON   |
| **Run Logs**        | `~/.openclaw/cron/runs/*.jsonl`               | JSONL  |
| **Sessions**        | `~/.openclaw/agents/*/sessions/sessions.json` | JSON   |
| **Config Override** | `OPENCLAW_STATE_DIR` env var                  | N/A    |

**Default:** `~/.openclaw/cron/jobs.json` 📍
