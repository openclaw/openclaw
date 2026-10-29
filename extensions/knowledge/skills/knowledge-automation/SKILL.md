---
name: knowledge-automation
description: Create scheduled Knowledge ingestion automations with a verified worker, private-vault authority, and an end-to-end scheduled run. Use when asked to schedule or repair recurring ingestion from any source.
---

# Knowledge automation

1. **Identify the job.** Inspect existing automations before creating a replacement.
   Confirm the authorized source, intended agent/vault, cadence and timezone.
   Verify the running OpenClaw installation and its current automation CLI/schema;
   a different CLI on PATH may target an incompatible installation. Finish with
   the intended job and any existing checkpoint identified.

2. **Establish the worker's authority.** For owner-private ingestion, use the
   verified OpenClaw 2026.9.8 composition: an operator-authored named-session
   automation targeting a retained, genuinely owner-delegated OpenClaw session.
   From the authorized owner conversation, use `sessions_spawn` with
   `runtime: "subagent"`, `cleanup: "keep"`, and no collector mode. Have the child
   check `knowledge_status` for the intended scope/agent/vault and read a known
   existing record when available; retain its returned session key. This is the
   persistent ingestion worker, not an internal research subagent.
   Operator scheduling alone does not grant private access. A fresh named
   session, detached `current` run, or headless script is not a substitute for
   delegation. Finish with a retained worker that has demonstrated intended access.

3. **Create the host automation.** Use the verified installation's supported
   operator CLI (`openclaw automations add`, or edit the intended existing job),
   with an agent-turn message and `--session "session:<returned-session-key>"`.
   Requester-scoped automation creation cannot target another conversation's
   workspace. If operator scheduling is unavailable, report that blocker; never
   fabricate owner context or edit stored authority receipts. Set the requested
   schedule/timezone, a sufficient timeout and a finite tool allow-list for the
   workflow. Discover the scheduled runtime's actual execution tools rather than
   assuming interactive tool names. Read back the target and job configuration.

   The job message must require, on every run:
   - Intended Knowledge scope/access preflight before acquisition or writes.
   - Fresh acquisition using the source's existing authorized credential route.
   - `knowledge-source-ingest` for incremental coverage/reconciliation where
     applicable, then `knowledge-ingest` or `knowledge-meeting-ingest` for content.
   - The selected workflow's verification before committing its checkpoint;
     preserve retryable work and the previous checkpoint on failure.
   - `AUTOMATION_FAILED` on its own first line for unresolved failure, followed
     by the reason. `NO_REPLY` is for successful no-change runs, not hidden errors.

4. **Prove the scheduled path.** Run through the scheduler, not just interactive
   tools. Require a terminal run receipt, correct vault access, verified saved
   coverage and checkpoint readback. Repeat with unchanged source content and
   verify no duplicate publication. Confirm a real timer firing as well; job
   creation or source listing alone does not prove ingestion. When replacing a
   job, disable the old one after verification and confirm only one is active.
   Report any untested publication or repeat behavior explicitly.

5. **Report operation and limits.** Give the job, cadence, next run and verified
   outcome. Check result delivery and failure alerts separately: quiet delivery
   (`delivery.mode: "none"`) leaves results in automation history and does not
   imply proactive notifications. Parent reset/removal/reassignment revokes
   delegation; worker reset or removal can also invalidate access. Check the
   effective reset/retention policy. On lost authority, stop writes and checkpoint
   advancement; recover only through a newly authorized owner delegation and
   supported retargeting, never self-reauthorization.
