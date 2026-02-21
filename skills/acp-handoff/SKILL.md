---
name: acp-handoff
description: >-
  Automatic Completion Protocol — structured handoff from implementation to code review.
  Use when: (1) an agent finishes implementation work and needs to hand off for review,
  (2) opening a PR and assigning a reviewer based on the tier pipeline,
  (3) checking the status of pending reviews or SLA compliance,
  (4) escalating stalled reviews. Automates: PR creation, reviewer assignment (tier-based
  with squad affinity), reviewer notification via sessions_send, workq status transition
  to in-review, and SLA tracking with escalation.
  NOT for: the actual code review itself — use coding-agent or github skills for that.
metadata:
  openclaw:
    emoji: "🤝"
    requires:
      bins: ["gh", "sqlite3", "jq", "git"]
---

# ACP Handoff — Automatic Completion Protocol

Structured handoff from implementation to code review. Replaces ad-hoc "ready for review" messages with an atomic workflow that ensures every completed branch gets a PR, an assigned reviewer, and SLA tracking.

## Quick Reference

### Hand off completed work

When you've finished implementation and pushed your branch:

```
Hand off branch <branch-name> for review
```

Or be more specific:

```
Hand off branch xavier/p0-cron-delivery-fixes for review.
Priority: P0. Summary: Fix cron delivery threading and suppress no-change progress checks.
Related issue: #22301
```

The skill will:

1. Validate the branch is pushed and has commits ahead of main
2. Open a PR with a structured description
3. Auto-select a reviewer based on the tier pipeline
4. Notify the reviewer via direct session message
5. Update workq status to `in-review` (if a workq item exists)
6. Track the review SLA

### Check pending reviews

```
Check ACP handoff status
```

Shows all pending reviews, their SLA status, and whether escalation is needed.

---

## How It Works

### Reviewer Selection (Tier Pipeline)

Reviewers are auto-selected based on the author's tier, per WORK_PROTOCOL.md:

| Author Tier       | Reviewer Pool                                |
| ----------------- | -------------------------------------------- |
| T4 (Engineer)     | T3 in same squad → T2 in same squad → any T3 |
| T3 (Mid)          | T2 in same squad → any T2 → T1               |
| T2 (Senior/Staff) | T2 peer → T1                                 |
| T1 (VP/C-Suite)   | T1 peer → Merlin                             |

### Review SLA

| Priority | Deadline | Escalation                  |
| -------- | -------- | --------------------------- |
| P0       | 15 min   | Next tier + #cb-inbox post  |
| P1       | 30 min   | Squad lead notification     |
| P2       | 2 hours  | Gentle reminder to reviewer |
| P3       | 8 hours  | No escalation               |

Default priority is P2 unless specified.

### Escalation

A companion cron (`acp-review-tracker`) checks pending reviews every 15 minutes:

- Approaching SLA → reminder to reviewer
- SLA breached → escalate per priority table above
- Reviewer unresponsive → reassign to next in line

---

## Implementation Details

### Scripts

All scripts are in `scripts/` relative to this SKILL.md.

#### `acp-handoff.sh` — Main handoff script

```bash
# Usage:
scripts/acp-handoff.sh \
  --branch <branch-name> \
  --repo <owner/repo> \
  --worktree <path> \
  --author <agent-id> \
  --priority <P0|P1|P2|P3> \
  --summary "What changed and why" \
  --issue <issue-number> \
  [--reviewer <agent-id>]    # override auto-selection
```

Returns JSON with: handoff ID, PR URL, assigned reviewer, SLA deadline.

#### `acp-status.sh` — Check pending handoffs

```bash
scripts/acp-status.sh [--author <agent-id>] [--reviewer <agent-id>] [--overdue]
```

#### `acp-escalate.sh` — Run escalation checks

```bash
scripts/acp-escalate.sh  # called by cron, checks all pending reviews
```

#### `acp-complete.sh` — Mark review as complete

```bash
scripts/acp-complete.sh --handoff-id <id> --status <approved|changes-requested>
```

### Database

SQLite database at `~/.openclaw/acp-handoff.db`

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  branch TEXT NOT NULL,
  repo TEXT NOT NULL,
  worktree TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  reviewer TEXT,
  reviewer_tier TEXT,
  priority TEXT DEFAULT 'P2',
  status TEXT DEFAULT 'pending-review',
  summary TEXT,
  issue_ref TEXT,
  files_changed TEXT,  -- JSON array
  handoff_at TEXT NOT NULL,
  sla_deadline TEXT NOT NULL,
  escalated_at TEXT,
  reminder_sent_at TEXT,
  reviewed_at TEXT,
  review_status TEXT,  -- approved, changes-requested
  workq_item_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_handoffs_status ON handoffs(status);
CREATE INDEX IF NOT EXISTS idx_handoffs_reviewer ON handoffs(reviewer);
CREATE INDEX IF NOT EXISTS idx_handoffs_author ON handoffs(author);
```

### Agent-to-Skill Interface

When an agent says "hand off branch X for review", the orchestrating agent should:

1. **Read this SKILL.md** (you're doing it now)
2. **Determine parameters** from context:
   - `branch`: from the agent's message or current git branch
   - `repo`: from git remote (usually `openclaw/openclaw`)
   - `worktree`: from the agent's working directory
   - `author`: the agent performing the handoff
   - `priority`: from context (default P2)
   - `summary`: from the agent's description of changes
3. **Run the handoff script** with those parameters
4. **Notify the reviewer** via `sessions_send` using the returned reviewer ID
5. **Report back** to the author with PR link and reviewer assignment

### Tier Configuration

The tier mapping is defined in `scripts/tier-config.json`. Update this file when the org structure changes.

---

## Cron Setup

After deploying, create a cron for escalation tracking:

```bash
openclaw cron add \
  --agent xavier \
  --name "ACP Review Tracker" \
  --every 900000 \
  --prompt "Run the ACP escalation check: execute scripts/acp-escalate.sh from the acp-handoff skill. If any reviews are overdue, notify the appropriate parties. If all reviews are on track, respond HEARTBEAT_OK." \
  --delivery-mode none
```

---

## Troubleshooting

- **`gh` not authenticated**: Run `gh auth login` on the host machine
- **No reviewer found**: Falls back to posting in #cb-inbox for manual assignment
- **Reviewer has no active session**: Posts to squad channel instead of direct message
- **workq not available**: Handoff proceeds without workq integration (logs a warning)
