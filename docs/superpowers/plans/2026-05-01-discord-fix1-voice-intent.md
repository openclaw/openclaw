# Discord Fix 1 — Suppress GuildVoiceStates Intent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `voice: { enabled: false }` to the Discord config in `openclaw.json` so the 4.27 gateway does not subscribe to the `GuildVoiceStates` WebSocket intent, eliminating idle CPU pressure for a text-only bot.

**Architecture:** Config-only change to `/home/ubuntu/.openclaw/openclaw.json`. No source edits, no image rebuild. File is owned by `opc` so all writes require `sudo` followed by `chown opc:opc`. Gateway restart picks up the new config.

**Tech Stack:** Docker Compose, OpenClaw 4.27, bash, Python 3 (for safe JSON editing)

---

### Task 1: Pre-flight — snapshot current config and confirm no override keys

**Files:**
- Read: `/home/ubuntu/.openclaw/openclaw.json`

- [ ] **Step 1: Confirm no existing `intents.voiceStates` override**

Run:
```bash
sudo cat /home/ubuntu/.openclaw/openclaw.json | python3 -c "
import json,sys
d=json.load(sys.stdin)
discord=d.get('channels',{}).get('discord',{})
print('intents:', discord.get('intents'))
print('voice:', discord.get('voice'))
"
```
Expected output:
```
intents: None
voice: None
```
If `intents` contains `voiceStates: true`, that key overrides `voice.enabled` and must also be removed/set to false. See Task 2 risk note.

- [ ] **Step 2: Take config backup**

```bash
mkdir -p ~/openclaw-backup-discord-perf
sudo cp /home/ubuntu/.openclaw/openclaw.json ~/openclaw-backup-discord-perf/openclaw.json.bak
```

- [ ] **Step 3: Capture baseline event loop metrics from logs**

```bash
docker logs openclaw-openclaw-gateway-1 2>&1 | grep "liveness warning" | tail -5
```

Note the `eventLoopDelayMaxMs` value. Target after fix: under 500ms.

---

### Task 2: Apply config change

**Files:**
- Modify: `/home/ubuntu/.openclaw/openclaw.json` (owned by `opc`, write via sudo + chown)

- [ ] **Step 1: Write the updated config**

```bash
sudo bash -c 'python3 << '"'"'EOF'"'"'
import json

path = "/home/ubuntu/.openclaw/openclaw.json"
with open(path) as f:
    d = json.load(f)

discord = d.setdefault("channels", {}).setdefault("discord", {})
discord["voice"] = {"enabled": False}

# If intents.voiceStates exists and is true, neutralize it too
intents = discord.get("intents")
if isinstance(intents, dict) and intents.get("voiceStates"):
    intents["voiceStates"] = False

with open(path, "w") as f:
    json.dump(d, f, indent=2)
    f.write("\n")
print("done")
EOF
chown opc:opc /home/ubuntu/.openclaw/openclaw.json'
```

Expected output: `done`

- [ ] **Step 2: Verify the change was written correctly**

```bash
sudo cat /home/ubuntu/.openclaw/openclaw.json | python3 -c "
import json,sys
d=json.load(sys.stdin)
discord=d['channels']['discord']
print(json.dumps({'voice': discord.get('voice'), 'intents': discord.get('intents')}, indent=2))
"
```

Expected output:
```json
{
  "voice": {
    "enabled": false
  },
  "intents": null
}
```

- [ ] **Step 3: Verify file ownership is still opc:opc**

```bash
ls -la /home/ubuntu/.openclaw/openclaw.json
```

Expected: `opc opc` in the owner/group columns.

---

### Task 3: Restart gateway and verify

**Files:**
- None modified

- [ ] **Step 1: Restart the gateway container**

```bash
cd /home/ubuntu/godwind-team-docker/openclaw && docker compose restart openclaw-openclaw-gateway
```

Wait for it to come back up (watch logs):
```bash
docker logs -f openclaw-openclaw-gateway-1 2>&1 | grep -m1 "gateway ready\|listening\|started"
```

- [ ] **Step 2: Confirm gateway is healthy**

```bash
docker ps --filter name=openclaw-openclaw-gateway-1 --format "{{.Status}}"
```

Expected: `Up X seconds (healthy)` or similar.

- [ ] **Step 3: Check startup logs for voice intent behaviour**

```bash
docker logs openclaw-openclaw-gateway-1 2>&1 | grep -i "voice\|intent\|GuildVoice" | head -20
```

In 4.27 there is no explicit startup log for the intent bitmask, so absence of voice-related errors is the expected result. Note any unexpected voice-related log lines.

- [ ] **Step 4: Wait one liveness cycle (30s) then check event loop**

```bash
sleep 35 && docker logs openclaw-openclaw-gateway-1 --since 60s 2>&1 | grep "liveness"
```

Compare `eventLoopDelayMaxMs` to the baseline captured in Task 1, Step 3. Target: meaningful drop. If no liveness warning appears, the event loop is healthy (warnings only fire when thresholds are exceeded).

---

### Task 4: Functional smoke test

- [ ] **Step 1: Send a simple message in Discord and time the response**

Send a short text message (e.g. "hello") in the Discord DM with the bot. Time from send to reply.

Target: under 10 seconds.

- [ ] **Step 2: Check for stuck sessions**

```bash
docker exec openclaw-openclaw-gateway-1 node dist/index.js sessions list 2>/dev/null | grep -i "processing\|stuck" || echo "no stuck sessions"
```

- [ ] **Step 3: Check CPU after 2 minutes of idle**

```bash
docker stats openclaw-openclaw-gateway-1 --no-stream --format "CPU: {{.CPUPerc}} | MEM: {{.MemUsage}}"
```

Target: CPU under 5% at idle (was 43% utilization before fix).

---

### Task 5: Document result and commit

- [ ] **Step 1: Record outcome in the audit log**

Append a brief result note to the workspace ops log:
```bash
sudo bash -c 'cat >> /home/ubuntu/.openclaw/workspace/OPENCLAW-OPS-LOG.md << '"'"'EOF'"'"'

## 2026-05-01 — Discord Fix 1: GuildVoiceStates intent suppressed

- Added `channels.discord.voice.enabled: false` to openclaw.json
- Gateway restarted; no voice-related startup errors
- eventLoopDelayMaxMs: [FILL IN before/after values]
- Idle CPU: [FILL IN before/after]
- Discord response time: [FILL IN]
EOF
chown opc:opc /home/ubuntu/.openclaw/workspace/OPENCLAW-OPS-LOG.md'
```

- [ ] **Step 2: Commit the spec and plan**

```bash
cd /home/ubuntu/godwind-team-docker/openclaw
scripts/committer "docs(specs): add Discord fix 1 implementation plan" docs/superpowers/plans/2026-05-01-discord-fix1-voice-intent.md
```

---

### Rollback

If the gateway fails to start or Discord stops receiving messages after the restart:

```bash
sudo cp ~/openclaw-backup-discord-perf/openclaw.json.bak /home/ubuntu/.openclaw/openclaw.json
sudo chown opc:opc /home/ubuntu/.openclaw/openclaw.json
cd /home/ubuntu/godwind-team-docker/openclaw && docker compose restart openclaw-openclaw-gateway
```
