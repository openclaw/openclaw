# ACP Handoff — Automatic Completion Protocol

_Author: Merlin (Main) | Date: 2026-02-21 | Status: Draft_
_Requested by: David_

---

## Problem

When agents complete implementation work, the handoff to code review is manual and unreliable. Agents post "ready for review" in Slack messages, but:

- No PR gets opened (branch is just pushed)
- No reviewer is formally assigned or notified
- No tracking of whether review actually happens
- No escalation if review is delayed

This creates a gap between "work complete" and "work reviewed" where tasks silently stall.

**Real example (2026-02-21):** Xavier completed P0 cron delivery fixes, pushed branch `xavier/p0-cron-delivery-fixes`, posted "Ready for T2+ review → merge" in #cb-inbox — but no PR was opened, no reviewer was assigned, and nobody was notified. David had to manually ask about it 30 minutes later.

---

## Solution: Structured Handoff Skill

A skill (`acp-handoff`) that any agent invokes when they complete implementation work. It performs the complete handoff sequence as an atomic workflow.

### Trigger

Agent completes work and invokes the handoff (either explicitly via skill, or detected by a post-work cron).

### Handoff Sequence

```
1. Validate branch state
   - Confirm branch is pushed to origin
   - Confirm branch has commits ahead of main
   - Run type-check / lint if applicable (fail-fast)

2. Open PR
   - Title: from branch name or agent-provided summary
   - Body: structured template with:
     - What changed and why
     - Files modified (fully qualified paths)
     - Related issue/task reference
     - Test coverage summary
   - Labels: auto-applied based on file paths (e.g., "gateway", "frontend", "cron")

3. Assign reviewer (auto-selected)
   - Based on WORK_PROTOCOL.md tier pipeline:
     - T4 (Engineer) work → T3 (Mid/Workhorse) reviewer
     - T3 work → T2 (Senior/Staff/Bridge) reviewer
     - T2 work → T2 peer or T1 reviewer
     - T1 work → T1 peer review
   - Reviewer selection considers:
     - Squad membership (prefer same-squad reviewers)
     - Current workload (prefer agents with fewer active reviews)
     - Domain expertise (prefer agents who've touched the same files)
   - Fallback: if preferred reviewer has no active session, try next in line

4. Notify reviewer
   - Send direct message via sessions_send to reviewer's main session
   - Include: PR link, summary, files changed, priority level, review SLA
   - If reviewer has no active session: post to squad channel or #cb-inbox

5. Update work queue
   - Transition workq item status: in-progress → in-review
   - Record PR number, reviewer assignment, handoff timestamp

6. Confirm to author
   - Reply to the completing agent with: PR link, assigned reviewer, expected SLA
```

### Review SLA & Escalation

| Priority      | Initial SLA | Escalation                                     |
| ------------- | ----------- | ---------------------------------------------- |
| P0 (critical) | 15 min      | Auto-escalate to next tier + post in #cb-inbox |
| P1 (high)     | 30 min      | Notify squad lead                              |
| P2 (normal)   | 2 hours     | Gentle reminder to reviewer                    |
| P3 (low)      | 8 hours     | No escalation                                  |

Escalation is handled by a companion cron (`acp-review-tracker`) that:

- Checks open PRs with pending reviews every 15 minutes
- Sends reminders when SLA is approaching
- Escalates when SLA is breached

### Reviewer Mapping (Initial)

Based on current org structure and WORK_PROTOCOL.md tiers:

| Author Tier                                                    | Default Reviewers (in preference order) |
| -------------------------------------------------------------- | --------------------------------------- |
| T4 (Barry, Nate, Oscar, Vince, Jerry, Piper, Quinn, Reed, Sam) | T3 in same squad → T2 in same squad     |
| T3 (Harry, Larry, Luis)                                        | T2 (Sandy, Tony, Roman, Claire)         |
| T2 (Sandy, Tony, Roman, Claire)                                | T2 peer → T1 (Tim, Xavier)              |
| T1 (Tim, Xavier, Amadeus, Julia)                               | T1 peer → Merlin                        |

### Data Model

```json
{
  "handoffId": "uuid",
  "author": "agent-id",
  "branch": "xavier/p0-cron-delivery-fixes",
  "prNumber": 22301,
  "prUrl": "https://github.com/openclaw/openclaw/pull/22301",
  "reviewer": "tim",
  "reviewerTier": "T1",
  "priority": "P0",
  "status": "pending-review",
  "handoffAt": "2026-02-21T14:04:00Z",
  "slaDeadline": "2026-02-21T14:19:00Z",
  "escalatedAt": null,
  "reviewedAt": null,
  "filesChanged": ["/path/to/file1.ts", "/path/to/file2.ts"],
  "workqItemId": "optional-reference"
}
```

### Implementation Approach

**Phase 1 — Skill + Manual Invocation**

- Build as an OpenClaw skill (`acp-handoff`)
- Agents invoke explicitly after completing work: "hand off branch X for review"
- Skill reads WORK_PROTOCOL.md for tier mapping, opens PR, assigns reviewer, notifies
- Track handoffs in a JSON file or SQLite (like workq)

**Phase 2 — Automatic Detection**

- Cron monitors for branches pushed without corresponding PRs
- Auto-triggers handoff when an agent posts "ready for review" or similar
- Integrates with workq status transitions

**Phase 3 — Review Completion Loop**

- Detect when reviewer approves/requests changes
- Auto-notify author of review feedback
- Track review turnaround metrics
- Auto-merge when approved (if configured)

---

## Dependencies

- `gh` CLI must be authenticated (`gh auth login` — currently blocked)
- Reviewer tier mapping needs to be maintained (source of truth: WORK_PROTOCOL.md or a dedicated config)
- workq integration (optional for Phase 1)

---

## Open Questions

1. Should this be a skill (invoked by agents) or a platform feature (built into OpenClaw core)?
   - Recommendation: Start as skill, graduate to platform if it proves valuable
2. Should auto-merge be supported for approved PRs?
   - Recommendation: Not in Phase 1 — David should retain merge authority initially
3. Where to store handoff state? JSON file vs SQLite?
   - Recommendation: SQLite (consistent with workq pattern)

---

## Success Criteria

- Zero "ready for review" messages that don't result in a PR + assigned reviewer
- Review SLA compliance > 90%
- No manual intervention needed for the handoff step
- Agents can complete work and trust that review will happen

---

_This spec should be reviewed by Xavier (CTO) and Tim (VP Architecture) before implementation begins._
