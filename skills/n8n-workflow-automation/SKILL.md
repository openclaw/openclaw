---
name: n8n-workflow-automation
description: Designs and outputs n8n workflow JSON with robust triggers, idempotency, error handling, logging, retries, and human-in-the-loop review queues. Use when you need an auditable automation that won’t silently fail.
---

# n8n workflow automation with retries, logging, and review queues

## PURPOSE
Designs and outputs n8n workflow JSON with robust triggers, idempotency, error handling, logging, retries, and human-in-the-loop review queues.

## WHEN TO USE
- TRIGGERS:
  - Build an n8n workflow that runs every Monday and emails the compliance summary.
  - Add error handling and retries to this workflow, plus a review queue for failures.
  - Create a webhook workflow that logs every run and writes a status row to a tracker.
  - Make this n8n flow idempotent so it does not duplicate records when it reruns.
  - Instrument this workflow with audit logs and a human approval step.
- DO NOT USE WHEN…
  - You need code-only automation without n8n (use a scripting/CI skill).
  - You need to bypass security controls or hide audit trails.
  - You need to purchase or recommend prohibited items/services.

## INPUTS
- REQUIRED:
  - Workflow intent: trigger type + schedule/timezone + success criteria.
  - Targets: where to write results (email/Drive/Sheet/DB) and required fields.
- OPTIONAL:
  - Existing n8n workflow JSON to modify.
  - Sample payloads / example records.
  - Definition of dedup keys (what makes a record unique).
- EXAMPLES:
  - Cron: Monday 08:00 Europe/London; send summary email + Drive upload
  - Webhook: receive JSON; route to folders

## OUTPUTS
- Default (read-only): a workflow design spec (nodes, data contracts, failure modes).
- If explicitly requested: `workflow.json` (n8n importable JSON) + `runbook.md` (from template).
Success = workflow is idempotent, logs every run, retries safely, and routes failures to a review queue.


## WORKFLOW
1. Clarify trigger:
   - Cron/webhook/manual; schedule/timezone; concurrency expectations.
2. Define data contract:
   - input schema, required fields, and validation rules.
3. Design idempotency:
   - choose dedup key(s) and storage (DB/Sheet) to prevent duplicates on retries.
4. Add observability:
   - generate `run_id`, log start/end, store status row and error details.
5. Implement error handling:
   - per-node error branches, retry with backoff, and final failure notification.
6. Add human-in-the-loop (HITL) review queue:
   - write failed items to a queue (Sheet/DB) and require approval to reprocess.
7. “No silent failure” gates:
   - if counts/thresholds fail, stop workflow and alert.
8. Output:
   - If asked for JSON: produce importable n8n workflow JSON + runbook.
9. STOP AND ASK THE USER if:
   - destination systems are unknown,
   - no dedup key exists,
   - credential strategy (env vars) is not specified,
   - the workflow needs privileged access not yet approved.


## OUTPUT FORMAT
If outputting **n8n workflow JSON**, conform to:

```json
{
  "name": "<workflow name>",
  "nodes": [ { "name": "Trigger", "type": "n8n-nodes-base.cron", "parameters": {}, "position": [0,0] } ],
  "connections": {},
  "settings": {},
  "active": false
}
```

Also output `runbook.md` using `assets/runbook-template.md`.


## SAFETY & EDGE CASES
- Read-only by default; only emit workflow JSON when explicitly requested.
- Do not include secrets in JSON; reference env vars/credential names only.
- Include audit logging + failure notifications; avoid workflows that can silently drop data.
- Prefer least privilege: call only required APIs and minimize scopes.


## EXAMPLES
- Input: “Cron every Monday, email compliance summary, retry failures.”  
  Output: Node map + `workflow.json` with Cron → Fetch → Aggregate → Email, plus error branches to review queue.

- Input: “Webhook that logs runs and writes status row.”  
  Output: Webhook → Validate → Process → Append status row; on error → log + notify + queue.

