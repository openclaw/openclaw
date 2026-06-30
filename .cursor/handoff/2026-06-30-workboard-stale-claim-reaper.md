# Cursor Cloud Agent Handoff — Workboard stale-claim reaper

**Date:** 2026-06-30  
**Repo:** `shrad3r/openclaw`  
**Merged commit:** `c808110102ccd87dc536b743666615985d9930fc`  
**PR:** https://github.com/shrad3r/openclaw/pull/2

---

## User problem

Telegram bot **Kai** spammed **Fleet task update** messages for card  
`TASK-IMPROVE-OFFLINE-ACCURACY-OF--70BC` — alternating **BLOCKED** / **Unblocked** every ~10 minutes.

Screenshot showed repeated flap between blocked and unblocked states on the same task.

---

## Root cause

Workboard **`workboard_dispatch`** cron loop:

1. Running card has **expired claim** + **stale heartbeat**
2. Dispatch marks card **`blocked`** (“Claim expired without a recent heartbeat.”)
3. Fleet monitor / automation **unblocks or re-promotes** the card
4. Next dispatch pass **blocks again** → endless flap

The `"Fleet task update"` wording is **deployment-side** (Kai bot formatting). The flapping source is **`extensions/workboard/src/store.ts`** dispatch logic.

---

## Fix (merged to `main`)

**PR #2** — stale-claim **reaper** instead of block/unblock loop:

| Situation                                | Before                              | After                                                |
| ---------------------------------------- | ----------------------------------- | ---------------------------------------------------- |
| Running + expired claim + stale activity | Blocked → notify → unblock → repeat | **Reaped as `done`** with `stale_claim_reaped` proof |
| Max runtime exceeded                     | Blocked                             | Blocked (unchanged)                                  |
| Expired claim + recent heartbeat         | Reclaim only                        | Reclaim only (unchanged)                             |

**Key files changed:**

- `extensions/workboard/src/store.ts` — dispatch reaper, `reaped` result array, `isStaleClaimActivity()`
- `extensions/workboard/src/store.test.ts` — 80 tests passing
- `extensions/workboard/src/tools.ts`, `cli.ts`, `command.ts`, `gateway.ts` — expose `reaped` in dispatch output
- `docs/plugins/workboard.md`, `docs/cli/workboard.md` — dispatch behavior docs

Aligns with upstream draft [openclaw/openclaw#97518](https://github.com/openclaw/openclaw/pull/97518), extended with clearer `reaped` reporting.

---

## What was done in cloud agent

- [x] Identified root cause (Workboard dispatch block loop)
- [x] Implemented + tested fix
- [x] Opened and **merged** PR #2 to `origin/main`
- [x] Verified tests: `pnpm test extensions/workboard/src/store.test.ts` (80 passed)

## What was **NOT** done

- [ ] Deploy to **Mac mini** (gateway host)
- [ ] Deploy to **MacBook**
- [ ] SSH / `openclaw gateway restart` on any physical machine
- [ ] Archive flapping card on live fleet

Cloud agent had GitHub access only — no fleet SSH, no Crabbox/Hetzner lease, no Mac filesystem access.

---

## Deploy on Mac mini (gateway host)

Run on the machine that runs **`openclaw gateway`**:

```bash
# Backup
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p ~/.openclaw/workspace/backups
cp -a ~/.openclaw/state/openclaw.sqlite \
  ~/.openclaw/workspace/backups/openclaw-before-stale-reaper-${STAMP}.sqlite

# Update (git checkout path — adjust to your clone)
cd ~/Projects/openclaw   # or your path
git fetch origin main && git checkout main && git pull --ff-only
pnpm install && pnpm build

# Restart gateway
openclaw gateway restart --deep

# One dispatch pass (reaps stale claims)
openclaw workboard dispatch

# Verify flapping card
openclaw workboard list --json | jq '.cards[] | select(.id|test("IMPROVE-OFFLINE|70BC")) | {id,status,proof:.metadata.proof[-1].label}'
```

Archive or move the flapping card to **done** in Workboard UI if it is still mid-loop.

---

## Deploy on MacBook

Depends on your setup:

- **MacBook = client only** (macOS app → mini gateway): update the **mini** first; MacBook app only needs to reconnect. No workboard code on laptop unless you run a local gateway.
- **MacBook runs its own gateway/checkout**: same git pull + build + restart steps as mini above in your local clone.

---

## Expected behavior after deploy

- Dispatch JSON/CLI shows **`reaped=N`** for stale abandoned workers
- Fleet monitors see **`completed`** + `stale_claim_reaped` proof — **not** BLOCKED ↔ Unblocked loops
- Max-runtime violations still **block** as before

---

## Chat transcript (condensed)

**User:** Fleet task BLOCKED/Unblocked spam still happening — what is the issue?

**Agent:** Explained dispatch block loop; implemented stale-claim reaper; opened PR #2.

**User:** Got rid (flapping stopped or card removed). Finalize holistically.

**Agent:** Added `reaped` dispatch array, docs, tests, hardened heartbeat detection; marked PR ready.

**User:** Run final deploy on fleet node.

**Agent:** Merged PR to GitHub `main`. Cannot SSH to fleet from cloud — provided exact deploy commands.

**User:** So this has been pushed to the MacBook and mini?

**Agent:** **No** — only GitHub `main`. Physical machines need manual `git pull` + gateway restart.

**User:** Send this chat to the local workspace folder on my MacBook Cursor.

**Agent:** This file.

---

## Quick verification after deploy

```bash
pnpm test extensions/workboard/src/store.test.ts -t "reaps stale"
openclaw gateway status --deep
openclaw workboard dispatch --json | jq '{reaped:(.reaped|length),blocked:(.blocked|length)}'
```
