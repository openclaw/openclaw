# Current Claw Cluster Architecture (Full Context)

## Machines / Roles

| Node | IP | User | Role | SSH |
|------|----|------|------|-----|
| Router | 10.0.0.1 | — | Network gateway | — |
| M1 (Inference) | 10.0.0.145 | — | Primary Ollama inference + heavy workers | local |
| M4 (Gateway) | 10.0.0.10 | fdclaw-m4 | OpenClaw Gateway + coordinator + storage | `ssh claw-m4` |
| i7 (Utility) | 10.0.0.11 | fdclaw-i7 | Utility worker + testing + overflow | `ssh claw-i7` |

### Role Details

- **M1 Mac Studio** — Primary inference. Ollama with qwen3.5:9b/4b/27b. Heavy workers + batch processing.
- **M4 Mac mini** — Always-on brain stem. OpenClaw Gateway (:18789), webhooks, cron, approvals. Ollama fallback (qwen3.5:2b).
- **i7 MacBook Pro** — Utility/overflow. Backup worker, testing, browser automation, low-priority tasks.

### OpenClaw Gateway (on M4)

The OpenClaw Gateway ([github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)) runs on M4 as the
command center. It handles:
- Channel integrations (Telegram/Discord/Slack)
- Agent routing (7 agents: 4 Full Digital + 3 CUTMV)
- Cron jobs (grant scans, digests, health checks)
- Approval flows via Telegram
- Inference routing to M1 Ollama (primary) or M4 Ollama (fallback)

Config: `gateway/openclaw.json5`
Bindings: `gateway/bindings/{fulldigital,cutmv}.json`
Start: `make gateway-start`

## Deployment Model: Git Clone (NOT rsync)

Each node has its **own independent git clone** at `~/openclaw`.
GitHub (private) is the distribution layer. **Never put the repo on the shared mount.**

```
# First-time setup (per node):
ssh claw-m4
cd ~
git clone git@github.com:YOUR_USERNAME/openclaw.git
cd openclaw
make full-bootstrap

# Updates (from M1 controller):
make cluster-update    # git pull + migrate on all nodes
```

### Why Git Clone > rsync

- Version history + deterministic builds
- Each node independently updatable
- CI compatible + easier rollbacks
- No file permission sync bugs
- rsync is reserved for media datasets / model files only

## Folder Layout Per Machine

```
~/openclaw                ← repo (local git clone)
~/openclaw/data           ← local SQLite DB
~/openclaw/.venv          ← local Python environment
~/openclaw/.env           ← local secrets (gitignored)

~/cluster                 ← SMB mount (shared artifacts ONLY)
~/cluster/jobs            ← job queue (pending/active/done/failed)
~/cluster/logs            ← centralized logs
~/cluster/results         ← output artifacts (renders, reports)
~/cluster/bin             ← shared scripts/tools
```

## What NEVER Goes In ~/cluster

- Repo code
- Virtual environments (.venv)
- SQLite database
- Secrets / .env files
- SSH keys

**~/cluster is for jobs, logs, and artifacts only.**

## Shared Cluster Folder

**Physical location (M4):** `/Users/fdclaw-m4/cluster`

Shared over **SMB** from M4. Mounted on i7 + M1 as `~/cluster`.

```
SMB path: //fdclaw-m4@10.0.0.10/cluster
M4 local: /Users/fdclaw-m4/cluster
i7 mount: ~/cluster
M1 mount: ~/cluster
```

### M4 convenience symlink

```bash
ln -sf /Users/fdclaw-m4/cluster ~/cluster
```

## Execution Model

- **Repo code** runs locally on each node: `~/openclaw`
- **Shared artifacts** (jobs, logs, results) use `~/cluster`
- **One physical directory** exists on M4 only. Everything else is a mount.

### Why not run code from SMB?

Running Python/Node from an SMB mount causes:
- File lock contention
- Slow imports
- Flaky `.pyc` caching
- macOS network mount permission bugs

Keep code local. Send outputs to the shared mount.

## Service Management

Services run in tmux sessions on each node:

```bash
make cluster-start     # Start app + worker in tmux on all nodes
make cluster-stop      # Kill tmux sessions on all nodes
make cluster-restart   # Stop + start
make cluster-logs      # Tail logs from all nodes
make cluster-status    # Git hash, migrations, service health
```

Each node runs two processes in the tmux session:
1. **App server** (FastAPI on :8080) — window 0
2. **Job worker** (polls ~/cluster/jobs) — window 1

Logs are written to `~/cluster/logs/{hostname}-app.log` and `~/cluster/logs/{hostname}-worker.log`.

## Job Routing Architecture

Jobs flow through the shared filesystem as JSON files:

```
~/cluster/jobs/
├── pending/    ← submitted jobs land here
├── active/     ← worker claims by atomic rename
├── done/       ← completed with result_path
└── failed/     ← exhausted retries
```

### Routing Strategy

| Lane | Preferred Node | Reason |
|------|----------------|--------|
| remotion_json | M4 | Has local assets (~/cutmv-ad-library) |
| ugc | i7 | CPU-heavy, no local assets needed |
| faceless | Any | Both nodes capable |
| pov | i7 | Compute worker |
| infographic | M4 | Pairs with Remotion pipeline |

### Stale Job Failover

If a job has been pending >5 minutes, **any worker can claim it** regardless of routing preference. This prevents jobs from getting stuck when the preferred node is down.

### Atomic Claims

`os.rename()` across SMB is atomic on macOS/APFS. If two workers race to claim the same job, only one rename succeeds. The loser gets `FileNotFoundError` and moves on.

## Data Flow Example

1. M1 submits a Remotion JSON render job to `~/cluster/jobs/pending/`
2. M4's worker picks it up (preferred node for remotion_json)
3. M4 renders using local assets at `~/cutmv-ad-library`
4. Output lands at `~/cluster/results/job_cutmv_remotion_json_abc12345.mp4`
5. M1 can read the result immediately via SMB

## Update Workflow

```bash
# From M1 (controller):
git push origin main              # Push changes to GitHub
make cluster-update               # Pull + migrate on all nodes
make cluster-restart              # Restart services with new code
make cluster-status               # Verify everything is healthy
```

## Security

- **Never store secrets on `~/cluster`** (SMB-shared, visible to all nodes)
- Secrets stay local: `~/openclaw/.env` (gitignored) or OS keychain
- Shared mount is "public-to-the-cluster": logs, results, artifacts only
- Each node needs its own SSH deploy key for GitHub access

## Environment Variables

```bash
OPENCLAW_REPO=~/openclaw
OPENCLAW_CLUSTER_DIR=~/cluster
OPENCLAW_DB=~/openclaw/data/openclaw.db
OPENCLAW_SHARED_JOBS=~/cluster/jobs
OPENCLAW_SHARED_LOGS=~/cluster/logs
OPENCLAW_SHARED_RESULTS=~/cluster/results
```
