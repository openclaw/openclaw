---
name: coe-root-cause
description: "Run a Correction of Error root-cause analysis for recurring failures, false success, missed work, data loss, and brittle automation."
---

# COE Root Cause

Use when the user asks for a COE, Correction of Error, postmortem, root-cause
analysis, "why did this recur", "what was missed", or "do not let this happen
again".

The job is to explain the mechanism that allowed the failure, fix the mechanism
where possible, and prove the same class of failure is harder to repeat.

## Rules

- Classify the failure before rerunning or changing anything.
- Do not stop at symptoms like "timeout", "model failed", "tool failed", or
  "human error".
- Preserve concrete evidence: logs, command output, diffs, tests, screenshots,
  report paths, source references, or exact user-visible behavior.
- Redact secrets, tokens, personally identifying information, customer data,
  and private workspace details. Prefer source references or short excerpts over
  raw dumps, especially in public artifacts.
- Ask before public, destructive, expensive, or externally visible actions.
- Keep private workspace, customer, or user details out of public artifacts
  unless the user explicitly approves disclosure.
- If the user asked only for a report or analysis, propose corrective actions
  instead of applying code or workflow changes.
- Every corrective action needs verification evidence. If it cannot be verified,
  rewrite it.
- If only an optional diagnostic failed, record a warning and continue the real
  task. If the diagnostic failure hides whether required work happened, treat it
  as a real COE trigger.

## Failure Types

Pick one primary type:

- real pipeline or data failure
- false success or silent skip
- repeated tool, cron, or agent failure
- timeout, rate limit, or transient provider failure
- missing file, schema drift, or dependency drift
- model configuration or policy failure
- source availability or extractor failure
- optional diagnostic failure

## Evidence Packet

Collect the smallest packet that explains the failure:

- user request or expectation
- promised behavior
- actual behavior
- first bad observable result
- affected scope
- relevant logs, reports, code paths, and tests
- existing guardrail that should have caught it

State uncertainty plainly. Do not bury the answer in unrelated logs.

## Analysis Loop

1. Build a short timeline with timestamps or ordered events.
2. Run at least 5 Whys.
3. Continue past 5 if the answer is still a symptom, vague human explanation,
   or unverifiable guess.
4. Separate proximate cause from root cause.
5. Name the missing guardrail, unclear interface, unsafe default, or unchecked
   assumption that let the issue recur or become user-visible.

Bad root causes:

- "the agent forgot"
- "the model made a mistake"
- "we should be more careful"
- "the command failed"
- "the user did not specify enough"

Good root causes identify a durable fix: a test, validator, workflow gate,
ownership boundary, safer default, clearer skill instruction, or explicit
blocked-state receipt.

## Corrective Actions

For each action, include:

- owner or owning surface
- exact change
- status: done, planned, blocked, or rejected
- verification evidence
- expected future detection signal

Prefer class-level safeguards over one-off cleanup.

## Verification Gate

Before saying the COE is complete, run the smallest credible verification:

- targeted regression test
- static validation for generated docs or frontmatter
- dry run against the failed case
- closeout checklist mapping each user request to evidence
- local AI/code review for nontrivial diffs

If a gate cannot run, say why and what evidence substitutes for it.

## Report Template

```markdown
# COE: <failure name>

Date: <date>
Status: done | planned | blocked
Severity: low | medium | high

## Summary
One short paragraph: what failed, why it mattered, and what changed.

## Impact
- Who or what was affected
- What was wrong or missing
- What was not affected

## Timeline
- <time/order>: <event>

## Failure Classification
<one classification and why>

## Evidence
- <source or command>: <what it proves>

## Root Cause
### 5+ Whys
1. Why? ...

### Root Cause Statement
<mechanism, not blame>

## Corrective Actions
| Action | Status | Verification |
| --- | --- | --- |
| ... | done/planned/blocked | ... |

## Verification
- <gate>: <result>

## Residual Risk
<what could still fail and how it will be noticed>
```

## Closeout

Lead with the root cause and verified fix. Keep the user-facing summary short.
If anything remains open, say exactly what evidence is still missing.
