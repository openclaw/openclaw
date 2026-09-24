---
name: update-team-server
description: "Update the operator-configured Team server unattended through its canonical deployment owner; verify serving code, supported migrations, session continuity, and recovery without duplicating the configured scheduler."
---

# Update Team server

Keep Team current automatically. Routine deployments, controlled interruptions, and supported upstream-owned migrations are already authorized for this workflow; do not request another routine approval. This is a repository operator skill, not a bundled runtime skill or a deployer implementation.

## Night Watch alone executes live updates

For the operator-configured Team server, only the designated **Team Server · Night Watch** owner may execute live updates through the canonical deployment controller. Verify that designation from the private runbook; a matching display name or possession of access is not authority. Other Codex tasks, sessions, agents, or operators must not execute or receive delegation for deployment, restart, cutover, rollback, or recovery. Coordination/admission may route the request to Night Watch, but must never designate an external executor. The routine authorization in this skill applies to Night Watch, not to readers of this skill.

Other workers may investigate, test, review, and land scoped fixes in isolated worktrees, then hand evidence and results to Night Watch for live execution. Repair or landing authority does not transfer live execution authority. Non-owner requesters retain coordination and follow-through until Night Watch verifies acceptance; they do not invoke the updater service themselves. Night Watch uses the existing controller and configured cadence, not a second deployer.

If an external live operation is already running, arrange a safe handback of that exact transaction to Night Watch through the existing owner's supported coordination/recovery path. Preserve its invocation identity, phase, lock, journal, maintenance authority, and receipts; reconcile whether writers or child processes are still active before Night Watch resumes. Do not launch a duplicate controller, reassign authority by editing records, blindly kill the operation, or treat a handoff acknowledgement as acceptance. If safe handback is unavailable, report the precise blocker privately and keep the request open without further unauthorized live actions. This rule grants no permission or security bypass.

## Resolve the owner

Read the operator-provided private deployment runbook before acting. Resolve and verify the host, access, canonical deployment command, service, sole configured cadence, lock, journal, release pointers, backup destination, and recovery contract from that configuration. Never guess access or copy private connection details, credentials, state, or receipts into public output.

Verify installed owner capabilities against their current source; this skill does not install a migration phase. Missing access or a safe capability is a concrete blocker: repair through the existing owner within authority, or report what remains unavailable. Never invent success or bypass a denial. Qualify suspected issues against the actual failing path before treating them as defects. Improve this updater guidance when confirmed issues expose a durable gap, and repair confirmed defects within the authorized update scope. Use isolated worktrees and subagents where useful; test and review repairs, then land them through normal CI, PR review, and `scripts/pr` landing without bypassing branch protection. Keep ownership through verified update acceptance; landed repairs alone do not complete the update. Do not delay an otherwise safe prepared update for unrelated repairs.

## Deploy through one owner

1. Preserve the operator-configured sole cadence and verify its intended state. A retired host timer may intentionally remain disabled when an authorized Gateway job owns the schedule. Never enable a legacy timer, pause the active cadence for proof, or create another scheduler/deployer. Inspect the active invocation, lock, and journal; observe an active owner instead of duplicating it. Resolve retained journals through canonical recovery before requesting a new deployment. Do not clear failed status to manufacture idleness.
2. When idle, Night Watch alone requests the configured updater service using its documented command. The canonical owner alone controls deployment, Gateway lifecycle, rollback, and recovery. Do not substitute direct restarts, partial build overlays, or an in-place source build.
3. Keep the incumbent serving while the owner freezes official upstream `main`, builds the complete release off-path, validates it, and seals it. After a new instruction to update to latest main following an interruption or outage, let the native controller freeze official `main` once for that request after canonical recovery permits a new deployment. Follow that recorded target through acceptance; do not chase moving main with externally sampled `--sha` assertions or repeat safe target-mismatch refusals. Check runtime-user disk/quota headroom, not just host free space.
4. Use the owner's genuine, unexpired maintenance authority bound to the incumbent generation. Use the configured graceful drain, then the owner's documented bounded-interruption mode when authorized; active agents and PTYs are not indefinite vetoes. Apply existing interruption authorization rather than repeatedly choosing a defer-only policy or asking again. Never bulk-cancel agents, abort sessions, clear queues, manually replay turns, or bypass persistence or locks to force idleness. Pending terminal persistence still blocks interruption. Never relabel DRAINING as READY. Bound shutdown, migration, startup, and verification separately; the drain budget is not total downtime.

## Retain ownership through acceptance

Keep an explicit update request open through busy deferral, failure, rollback, and recovery until full native acceptance or a concrete external/access blocker requiring outside action. Respect a user pause or cancellation. A restored incumbent is recovery, not completion of the requested update.

Inspect the exact invocation and reconcile its journal before continuing through the same owner. Before ending a turn with work pending, establish an active observation/completion path or a supported continuation through the existing owner, and return with acceptance or the exact blocker without another user prompt. A cadence alone is not proof that this request will resume. If no continuation path is available, report that specific blocker; do not promise unattended follow-through. Preserve safeguards and evidence rather than retrying blindly or creating another scheduler.

## Notify only around actual downtime

Keep Team notifications to two concise notices for an actual interruption: immediately before the canonical owner begins planned downtime, after preparation and cutover gates permit it; and once service is verified back. Starting an update request, preflight, or drain is not itself downtime. Coordinate with the owner's existing notification path so observers do not duplicate notices. If no safe notification boundary is available, report that limitation privately rather than announce speculative downtime or bypass the owner.

Do not post to Team for preflight failures, blocked or deferred attempts, no-op attempts, diagnosis, or other non-actions. Report their outcome, next action, and concrete blockers privately to the requesting user. Quiet Team reporting does not end ownership of the update or waive follow-through, acceptance, recovery, or safety requirements.

For an accepted update, the back-online notice includes concise highlights of changes landed on official `main` between the previous accepted serving commit and the newly accepted serving commit. Resolve both endpoints from the owner's accepted serving records and inspect that exact Git range; do not summarize from request time, a failed candidate, a release label, or moving `main`. Mention only changes included in the accepted range. If that history cannot be verified, say the highlights are unavailable rather than invent them.

If service returns through rollback or same-release recovery, say it is restored on the previous version and the requested update has not succeeded; do not advertise candidate changes as deployed. Send the back-online notice only after the owner's applicable recovery/readiness verification, keep unresolved update blockers private, and continue the requested update through the canonical owner unless paused, canceled, or externally blocked. Keep detailed receipts, logs, private access details, and full hashes out of Team notices.

## Cross schemas safely

Before stopping writers, identify the exact incumbent/candidate reader contracts, supported Doctor migration, and durable phase/recovery owner. Package versions and numeric schema ceilings alone are insufficient. Require the owner to prove these gates before mutation:

- A complete database inventory, including configured external agent roots and registered stores; verified WAL-aware backups covering that inventory and protected state. Check backup omissions and sanitization: a portable export is not necessarily a full recovery image. Doctor does not create the backup.
- The original pre-cutover session-preservation witness, retained through recovery; a filtered session-list page, empty baseline, or fresh-current witness cannot prove historical continuity.
- Stopped writers and maintenance authority fencing new claims. Only the candidate's supported upstream Doctor flow performs migration; assess its full repair scope, not a presumed single-table operation.
- Per-database integrity, physical schema, `PRAGMA user_version`, `schema_meta`, ownership, registry, and candidate runtime-readiness checks before and after migration. One successful database or healthy HTTP cannot prove all-agent readiness.

Transactions may commit per database, leaving mixed schemas or stale registry metadata after interruption. Once any database advances beyond the old reader's contract, never automatically restart that old reader, even when candidate verification fails. Preserve the journal and backups; continue through the canonical forward-recovery owner until every store is ready. Before mutation, a safe refusal leaves the incumbent serving. No custom schema SQL, version-marker edits, downgrade, or wholesale backup restoration.

Read [database contracts](https://docs.openclaw.ai/reference/database-schemas) and [backup semantics](https://docs.openclaw.ai/cli/backup); their general recovery examples do not expand this workflow's authority.

## Verify and recover

Require the exact invocation's successful deployment receipt, matching new serving/build SHA, stable process generation, RPC, health/startup/readiness, configured channels, unchanged protected policy/identities, and original-witness verification. Reuse the owner's real model-marker receipt; do not send duplicate marker turns. Require journal resolution and the intended state of the configured sole cadence. Read the native result, not just the observer process status: observer exit `0` can wrap native exit `75`/deferred and is not accepted deployment. Supervisor success, a skip, healthy old code, rollback, or same-release recovery is not a new deployment.

Bracket live checks with generation and owner-phase checks; never run ordinary RPCs across an active fence or pause the configured cadence for a quiet proof window. Preserve failed outcomes and unresolved journals; do not delete evidence or retry blindly. Use only the owner's compatibility-checked recovery and cleanup, preserving referenced releases, backups, ordinary sessions, unrelated state, and dirty workspaces.

Let [Gateway restart recovery](https://docs.openclaw.ai/gateway/restart-recovery) resume eligible work; do not duplicate it manually. PTYs end, unsaved work may be lost, and recovery budgets/quarantine remain: neither universal recovery nor exactly-once execution is promised.

Keep detailed invocation, serving SHA, migration/readiness, continuity, and recovery receipts private. Report progress and results in one to three short, friendly lines: what happened, what happens next or the exact blocker, and a short SHA only when useful. Light humor is welcome when it does not obscure a failure; omit repeated logs and full hashes. No credential rotation, release publication, security-policy weakening, or unrelated mutations are authorized.
