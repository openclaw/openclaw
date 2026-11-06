# Triage, assignment, and closure

- Queue discovery, related-item research, assignment, explicitly authorized labels/closes. review/list = read-only.

## Discovery

- Local Gitcrawl candidates → narrow live `ghx` verification. Broad sync/enrichment only if requested or freshness blocks decision. Search title/body first; comments when relevant. Similarity score ≠ duplication/closure proof.
- Requested count: qualified items only; report exhausted search, never pad. Favor concrete current bugs, understood owner, feasible proof. Small-fix request excludes feature/product choices, unclear/broad ownership. Short diff ≠ low risk.
- Generic shortlists: external contributors first. Exclude broad-access maintainer PRs younger than 14 days unless named/explicit maintainer-work request. Verify uncertain finalist permissions, never every author's full history. Suppress maintainer-authored issues in generic discovery unless scope-relevant.

## Assignment

- Before deep named-item work: inspect assignees. Another assignment less than six hours old = active ownership; continue only with direction. Older = hint, not veto. Unverifiable time = unknown. Preserve co-assignees; never replace without explicit authority.
- Age matters → current assignment timeline evidence. Claim only named unassigned item under assignment/landing/autonomous-resolution authority, with authenticated writer's actual login.

## Labels and closes

- Read current response/label policy before mutation. Choose one route: an authorized reason label lets Barnacle own the standard comment/close/optional lock, or an explicitly authorized manual comment+close uses the same message once as the authenticated human. Never combine both routes. A copied human warning is human activity, not an authenticated Barnacle grace receipt. Families: skill/support/third-party integration routing, submission limits, spam, invalid/dirty items. Verify actual label; never invent.
- Fixed issue/superseded PR: prove same-or-better current main. Inspect symptom/surfaces, preserve unique proof, comment canonical fix + proof before authorized close. Mitigation/diagnostic ≠ primary repair. Uncertain/actively held work stays open.
- Product rejection, won't-implement/out-of-scope = maintainer judgment. Explicit decision/close scope → handle directly associated cluster consistently; state rationale, supported alternative, reopening evidence. Keyword ≠ neighborhood closure authority.
- Root bulk-mutation approval limits apply. Uncertain ownership/evidence/trust/authority → stop; vague instruction ≠ mass closures.

## Administrative inactivity

- One owner: `scripts/github/stale-lifecycle.mjs`; schedule, explicit issue/PR targets, dry-run and backfill share it.
- Ordinary unassigned issues/PRs: 7 inactive days + 7 notice days. Assigned: 14 inactive + 7 notice. Bug issues: 30 inactive + 14 retest days regardless of contributor assignment. Creation age never overrides recent human activity.
- Human comments/reviews, content edits, assignment changes and PR head changes reset activity. Bot reviews/ratings do not. Current maintainer ownership, security/P0/P1 and durable `no-stale` holds preserve; `bad-barnacle` suppresses Barnacle before effects.
- Normalize known freeform maintainer holds to `no-stale` before enabling migration for affected items; adjudicate with their owner, never infer release from silence. Do not hardcode item IDs or interpret natural-language holds automatically.
- Version/cohort/head changes require a fresh authenticated v2 notice and full grace. Silence authorizes administrative closure, never a fixed/duplicate verdict. Bug issue closes use `not_planned`; they remain unlocked for retest replies.
- Manual copies cannot become automation receipts. Verify canaries through actual bot warnings and real grace; clock-controlled fixtures cover immediate terminal behavior. Use `item_numbers`, `dry_run=true` and a small `max_closures`, then an explicitly approved live bounded run of the same workflow. No shortened cooldown or alternate executor.
