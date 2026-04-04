---
description: "Operational security patterns for multi-agent OpenClaw deployments — credential lifecycle, circuit breakers, file integrity, incident response"
title: "Multi-Agent Security Operations"
---

# Multi-Agent Security Operations Guide

> **Scope:** Operational security patterns for multi-agent OpenClaw deployments. Assumes you've already applied the [hardened baseline](/gateway/security) configuration. This guide covers what comes after — the monitoring, credential lifecycle, integrity assurance, and incident detection that keep a production deployment secure over time.
>
> **Trust model:** Single trusted operator, multiple agents with varying privilege levels. See [Security](/gateway/security) for the trust model discussion.

---

## Why operational security matters

Config hardening is day-one work. Operational security is everything after:

- Credentials expire, rotate, and drift
- Agents get new capabilities and new attack surface
- Files change — sometimes legitimately, sometimes not
- Containers run unattended for weeks
- Cron jobs fail silently and burn tokens

The patterns below are drawn from a production 9-agent deployment running on a dedicated server. They're not theoretical — each one exists because something broke or was found exposed during a live audit.

---

## 1. Credential lifecycle management

### The problem

A multi-agent deployment has credentials scattered across:

- `openclaw.json` (gateway tokens, channel tokens)
- `auth-profiles.json` (model provider API keys, per agent)
- Workspace `.env` files (integration API keys)
- `.tokens/` directories (OAuth tokens)
- LaunchAgent plists (service env vars)

Without lifecycle management, you end up with plaintext credentials persisting indefinitely across multiple locations.

### Recommended architecture

```
Encrypted source of truth (sops/age, Vault, 1Password CLI, etc.)
        │
        ▼
SecretRef exec provider ──► openclaw.json (${{ secrets.* }})
        │                    auth-profiles.json (${{ secrets.* }})
        │
        ▼
Per-agent credential distribution
        │
        ├── sandbox.docker.env (for containerized agents)
        └── Mounted workspace .env (fallback)
```

**Key principles:**

- **One encrypted source of truth.** All credentials originate from one place.
- **Per-agent least privilege.** Each agent receives only the credentials it needs. A research agent doesn't need ERP credentials.
- **SecretRef over plaintext.** Use `${{ secrets.NAME }}` in config files. Values resolve to in-memory snapshots at startup — never written to disk by the gateway.
- **Separate local and remote gateway tokens.** If the remote token is compromised, the local gateway remains secure.

### Implementation with sops + age

```bash
mkdir -p ~/.openclaw/scripts

cat > ~/.openclaw/scripts/sops-secret-provider.sh << 'SCRIPT'
#!/usr/bin/env bash
set -uo pipefail
# SecretRef exec provider — JSON protocol
# Stdin:  {"ids": ["KEY_1", "KEY_2"]}
# Stdout: {"values": {"KEY_1": "val1", "KEY_2": "val2"}}

DECRYPTED=$(sops --input-type dotenv --output-type dotenv \
  -d ~/.openclaw/.env.enc 2>/dev/null) || true
if [ -z "$DECRYPTED" ]; then
  echo '{"values":{}}'; exit 0
fi

export _SOPS_DECRYPTED="$DECRYPTED"
exec python3 -c '
import sys, json, os

ids = json.load(sys.stdin).get("ids", [])
env_map = {}
for line in os.environ.get("_SOPS_DECRYPTED", "").splitlines():
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        env_map[k.strip()] = v.strip()

values = {k: env_map[k] for k in ids if k in env_map}
json.dump({"values": values}, sys.stdout)
'
SCRIPT
chmod 700 ~/.openclaw/scripts/sops-secret-provider.sh
```

```json
// openclaw.json — secrets provider config
{
  "secrets": {
    "providers": {
      "sops": {
        "source": "exec",
        "command": "/path/to/sops-secret-provider.sh",
        "passEnv": ["HOME", "PATH", "SOPS_AGE_KEY_FILE"],
        "jsonOnly": true
      }
    }
  }
}
```

### Per-agent distribution script

Rather than giving every agent access to every secret, generate scoped `.env` files:

```bash
#!/usr/bin/env bash
# generate-agent-envs.sh — distribute credentials by agent need
DECRYPTED=$(sops --input-type dotenv --output-type dotenv -d ~/.openclaw/.env.enc)

distribute() {
  local workspace="$1"; shift
  local env_file="$HOME/.openclaw/${workspace}/.env"
  : > "$env_file"
  for key in "$@"; do
    echo "$DECRYPTED" | grep "^${key}" >> "$env_file" || true
  done
  chmod 600 "$env_file"
}

distribute "workspace-data-sync" "CRM_" "ERP_" "FLEET_" "HR_"
distribute "workspace-ops"       "CLOUD_"
distribute "workspace-comms"     "EMAIL_"
distribute "workspace-research"  "SEARCH_" "SCRAPE_"
# security, analytics, internal agents get NO credentials
```

### Container credential gap

**Important:** Sandbox containers do NOT inherit resolved SecretRef values from the host. Containers receive credentials via:

1. Mounted workspace `.env` files (current default)
2. `sandbox.docker.env` config (preferred — values resolve from SecretRef at container creation)

Until SecretRef → `docker.env` is fully wired, the per-agent `.env` approach is the practical path.

---

## 2. Circuit breaker pattern for external services

### Silent token expiry

Cron jobs that call external APIs (OAuth services, SaaS APIs) will fail silently when tokens expire. Without circuit breakers, a single expired token can cause hundreds of failed runs, burning tokens and compute with no alert.

_Real example: An expired MS Graph token caused 40+ failed cron runs over 21 hours, consuming ~640K tokens before anyone noticed._

### Pre-flight check pattern

```
Pre-flight check (< 5 seconds, < 500 tokens)
        │
        ├── PASS → Run actual job
        └── FAIL → Write alert file, bail immediately
```

### Implementation

Every cron job that touches an external API should include a pre-flight instruction:

```
CIRCUIT BREAKER — MANDATORY FIRST STEP:
Run: node /workspace/scripts/check-msgraph-token.js

If it reports EXPIRED or ERROR:
1. Write an alert: echo "MS Graph token expired" > /workspace/outbox/alert-token-expired.md
2. Reply with the error message
3. Do NOT proceed with the main task

Only if token is VALID, continue with the actual work.
```

The pre-flight script should:

- Check credential validity (token expiry, API key test endpoint)
- Complete in under 5 seconds
- Return a clear PASS/FAIL status
- Cost minimal tokens (no LLM reasoning needed)

---

## 3. File integrity monitoring

### Why it matters

Agent persona files (`SOUL.md`, `MEMORY.md`, `AGENTS.md`) define agent behavior. Silent modification — whether by a compromised agent, a bug, or an adversarial prompt — can change how agents operate without anyone noticing.

### Recommended approach

Store SHA-256 hashes of critical files. Check daily. Alert on unexpected changes.

```javascript
// check-file-integrity.js (simplified)
const crypto = require("crypto");
const fs = require("fs");

const WATCHED_FILES = ["SOUL.md", "MEMORY.md", "AGENTS.md", "USER.md", "IDENTITY.md", "TOOLS.md"];

// --init flag: generate baseline
// Normal run: compare against baseline, alert on mismatch
```

Schedule as a daily cron job. On mismatch:

1. Alert the operator (Telegram, email, webhook)
2. Log which file changed and the new hash
3. Do NOT auto-revert — the change may be legitimate

### What to watch

| File          | Risk if tampered                            |
| ------------- | ------------------------------------------- |
| SOUL.md       | Agent personality/behavior change           |
| AGENTS.md     | Delegation rules, authority boundaries      |
| TOOLS.md      | Tool usage patterns, operational procedures |
| USER.md       | Operator identity, preferences              |
| MEMORY.md     | Historical context, decision references     |
| openclaw.json | Gateway config, security settings           |

---

## 4. Infrastructure baseline document

### Why you need one

Security audits produce findings. Without a canonical baseline, every audit rediscovers the same "issues" — or worse, flags intentional configurations as vulnerabilities.

_Real example: An audit flagged 3 unsandboxed agents as a critical finding. Investigation showed one (main) had exec/process denied via tool policy, making sandboxing redundant. The others were read-only agents with no dangerous tool access. Without a baseline, we'd have wasted time "fixing" an accepted risk._

### Recommended structure

Maintain a single `infrastructure-baseline.md` that documents:

1. **Host & OS** — exact versions, verified from CLI output
2. **OpenClaw configuration** — all security-relevant settings with current values
3. **Agent architecture** — roster, sandbox status, network, tool policies, credential scope
4. **Credential lifecycle** — what's encrypted, what's plaintext, planned migration
5. **Container hardening** — verified flags from `docker inspect`, not assumed
6. **Monitoring stack** — what's checked, how often, what alerts
7. **Security controls** — each control with status, limitations, and verification method
8. **Data flow** — how data moves between agents, memory, and external services
9. **Open gaps** — known issues with severity, phase, and notes
10. **LaunchAgents** — all persistent services with their env vars

**Rules:**

- Every fact must have a source (CLI output, file inspection, docker inspect)
- No secret values — only names, paths, and architecture
- Any agent writing security findings must reconcile against this file first
- Update after every infrastructure change

---

## 5. Monitoring stack

### Health check hierarchy

| Layer            | Frequency    | What it checks                         |
| ---------------- | ------------ | -------------------------------------- |
| Gateway health   | Every 10 min | Gateway process, API response          |
| Memory server    | Every 10 min | Server process, auth, query response   |
| Database         | Every 10 min | PostgreSQL connectivity                |
| Host resources   | Every 10 min | RAM usage, swap, disk                  |
| Session bloat    | Every 10 min | Session token counts                   |
| Cron health      | Every 10 min | Scheduler status, stuck jobs           |
| Token freshness  | Every 30 min | OAuth token expiry                     |
| Data pipeline    | Every 2 hrs  | End-to-end email/calendar flow         |
| Integrity        | Daily        | File hash verification                 |
| Credential scrub | Daily        | Session transcript credential patterns |
| Audit log scrub  | Weekly       | Config audit log secret leak cleanup   |

### Alert routing

Don't alert on everything. Categorize:

| Severity | Action                          | Example                                                  |
| -------- | ------------------------------- | -------------------------------------------------------- |
| Critical | Immediate operator notification | Gateway down, memory server unreachable                  |
| High     | Notification + auto-fix attempt | Token expired (auto-refresh), session bloat (auto-prune) |
| Medium   | Log + daily digest              | File integrity change, credential pattern in transcript  |
| Low      | Log only                        | Routine cleanup, successful health checks                |

### Session transcript scrubbing

Agent sessions contain conversation logs that may include credentials mentioned in context. Schedule a daily scrub:

```bash
# Find session files >60 min old, scrub credential patterns
# -i.bak is portable across macOS (BSD) and Linux (GNU) sed
find ~/.openclaw/agents/ -name "*.jsonl" -mmin +60 \
  | xargs sed -i.bak 's/sk-[A-Za-z0-9]\{20,\}/[SCRUBBED]/g'
  # Add patterns for your credential formats
  # Clean up backup files after:
  # find ~/.openclaw/agents/ -name "*.jsonl.bak" -delete
```

---

## 6. Agent authority boundaries

### The risk

In a multi-agent system, agents can potentially modify each other's files, send messages as each other, or escalate privileges through delegation chains.

### Defining authority tiers

| Tier                     | Agent can do autonomously                                                         | Examples                                    |
| ------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------- |
| **Auto-fix**             | Update own posture files, write alerts, update standards docs                     | Cyber agent updating threat intel           |
| **Propose only**         | Draft config changes, propose new crons, suggest permission changes               | Must be reviewed by operator                |
| **Escalate immediately** | Active credential exposure, unauthorized file modification, detected exfiltration | Notify operator, do not attempt remediation |

Document these boundaries in each agent's `AGENTS.md` or guardrail file. The orchestrator agent enforces them through delegation rules.

### Cross-agent isolation

- Containerized agents can only access their own workspace (bind mount)
- `sessions_send` allows inter-agent messaging but not file access
- The orchestrator (main) is the only agent with cross-workspace read access
- No agent should have write access to another agent's persona files

---

## 7. Sandboxed agent IO routing (the ops-request pattern)

### The challenge

Sandboxed agents run in read-only Docker containers with no exec, no internet (on internal networks), and only their own workspace mounted. But they still need to interact with the host: run scripts, read logs, send files, fetch attachments, write to shared memory.

Giving containers exec access or host mounts defeats the sandbox. You need a controlled, auditable channel.

### Convention-based file routing

```
Agent writes file to /workspace/outbox/
        │
        ▼
fswatch detects new file (host-side)
        │
        ▼
agent-io-router.sh reads filename prefix
        │
        ├── ops-request-*.json → Validate action + target against allowlist
        │                         → Execute → Write result to /workspace/inbox/
        ├── alert-* → Escalate to exec-ops agent
        ├── {source}-* → Route to data-lake/{source}/{date}/
        ├── *.md → Route to memory-inbox/ → pgvector indexing
        └── everything else → data-lake/unknown/{date}/
```

**No LLM in the loop.** Routing is pure filename convention — deterministic, auditable, zero token cost.

### Security properties

| Property                      | How it's enforced                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **No direct host exec**       | Agent has no exec tool; must go through ops-request                                                                       |
| **Action allowlist**          | Only specific ops-request actions are valid (read-file, run-script, health-check, etc.)                                   |
| **Path validation**           | `run-script` only accepts `.py`/`.js` under an approved scripts directory. `read-file` blocks `.env` and `.tokens/` paths |
| **No cross-workspace access** | Docker bind mount is workspace-only. Data-lake, memory-inbox, other workspaces are unreachable                            |
| **Audit trail**               | Every ops-request produces a result file. The routing action is logged                                                    |
| **Alert escalation**          | Files prefixed `alert-*` automatically route to the exec-ops agent for triage                                             |
| **Memory credential filter**  | `.md` files reaching memory-inbox are scanned for credential patterns before pgvector ingestion                           |

### ops-request protocol

Agent writes `ops-request-{timestamp}.json` to its outbox:

```json
{
  "action": "run-script",
  "target": "/path/to/scripts/check-token.js",
  "id": "req-001"
}
```

Router validates, executes, writes result to agent's inbox:

```json
{
  "id": "req-001",
  "status": "ok",
  "output": "Token valid, expires in 47 minutes"
}
```

**Allowed actions:**

| Action                   | Scope                                  | Blocked paths                          |
| ------------------------ | -------------------------------------- | -------------------------------------- |
| `read-file`              | Config directory paths only            | `.env`, `.tokens/`                     |
| `run-script`             | `.py`/`.js` under approved scripts dir | `.sh` files, paths outside scripts dir |
| `tail-log`               | Logs directory only                    | —                                      |
| `health-check`           | Named services only                    | —                                      |
| `list-dir`               | Config directory paths only            | —                                      |
| `send-telegram-file`     | Config directory paths only            | Max 50MB                               |
| `fetch-email-attachment` | Via MS Graph message ID                | Binary saved to approved dir           |
| `fetch-onedrive`         | Relative OneDrive paths                | Binary saved to approved dir           |

### fswatch reliability

fswatch can go zombie after extended uptime — process runs but stops delivering events. Mitigations:

- Health cron restarts fswatch if it's been running >24h or is missing
- Bulk file writes need 200-500ms delays between creates (bursts >100 can overwhelm fswatch)
- All workspace outboxes must be in the watch list — unwatched outboxes fail silently

### Filename prefix trap

Routing rules are evaluated by prefix before file extension. A file named `app-api-docs.md` that matches a data-source prefix (e.g., `app-*`) routes to data-lake **before** it reaches `*.md` → memory-inbox. The file goes to data-lake, not memory.

Safe prefixes for memory-bound `.md` files: `api-ref-*`, `doc-*`, `ref-*`, or any prefix not claimed by a data source.

### Why this matters for security

This pattern is the **only authorized channel** between sandboxed agents and the host. Without it, you'd need one of:

- Giving agents exec access (breaks sandbox)
- Mounting host directories (breaks isolation)
- Manual operator intervention for every host action (breaks automation)

The IO router is the controlled blast door between "agent wants to do something on the host" and "something happens on the host."

---

## 8. Incident response playbook

### Credential exposure detected

1. Identify scope: which credential, which agent, which log/file
2. Rotate the credential at the source (provider dashboard)
3. Update `.env.enc` (or your secret store)
4. Regenerate per-agent `.env` files
5. Restart affected agents
6. Scrub the exposed credential from logs, transcripts, audit files
7. Check if the credential was used after exposure (provider audit logs)

### Agent behavior anomaly

1. Check SOUL.md / AGENTS.md integrity (hash comparison)
2. Review recent session transcripts for the agent
3. Check if any cron jobs were created or modified
4. Review ops-request history for unauthorized actions
5. If compromised: kill agent sessions, restore persona files from baseline, restart

### Gateway crash-loop

1. Check `~/.openclaw/logs/` for the most recent gateway log
2. Common cause: invalid config value (e.g., `redactSensitive: "all"`)
3. Fix the config file manually
4. Restart the gateway using one of:
   - `openclaw gateway restart` (recommended)
   - The OpenClaw app restart control (if using the menubar app)
   - `launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway` (if using a custom LaunchAgent)
5. Verify with `openclaw gateway status`

---

## 9. Audit checklist

Run periodically (weekly or after changes):

```bash
# 1. Built-in security audit
openclaw security audit --deep

# 2. Secrets coverage
openclaw secrets audit

# 3. Container hardening verification
docker ps -q | xargs docker inspect \
  | jq '.[].HostConfig | {ReadonlyRootfs, CapDrop, SecurityOpt, Privileged, Memory, NanoCpus}'

# 4. Permission check on sensitive files
ls -la ~/.openclaw/openclaw.json ~/.openclaw/.env.enc \
  ~/.openclaw/workspace-*/.env ~/.openclaw/identity/

# 5. Credential leak scan in logs
grep -rl 'sk-\|xoxb-\|ghp_' ~/.openclaw/logs/ ~/.openclaw/agents/*/sessions/

# 6. File integrity
node ~/.openclaw/workspace-main/scripts/check-file-integrity.js

# 7. Stale token check
node ~/.openclaw/workspace-main/scripts/check-msgraph-token.js
```

---

## Appendix: Lessons learned

These are real issues found during production operation:

| Issue                                      | Impact                                | Lesson                                                                       |
| ------------------------------------------ | ------------------------------------- | ---------------------------------------------------------------------------- |
| `redactSensitive: "all"` crashes gateway   | Extended downtime                     | Test config changes on a non-production instance first                       |
| Config audit log leaks secrets in argv     | Credential exposure at rest           | Security controls need their own security review                             |
| Expired OAuth token → 40+ failed cron runs | 640K wasted tokens, 21h blind spot    | Circuit breakers are mandatory for external API jobs                         |
| 6 workspace outboxes not in fswatch        | Silent routing failures for agents    | Audit fswatch targets whenever agents are added; file routing fails silently |
| Session transcripts contain credentials    | Credential persistence in logs        | Schedule daily transcript scrubbing                                          |
| Assumed container hardening ≠ verified     | False confidence in security posture  | Always verify with `docker inspect`, never assume                            |
| Infrastructure baseline drift              | Audits produce contradictory findings | Maintain one canonical baseline, reconcile before reporting                  |

---

_This guide is a living document. Update it as your deployment evolves and new patterns emerge._
