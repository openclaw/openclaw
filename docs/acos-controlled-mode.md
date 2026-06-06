---
summary: "Run OpenClaw as an ACOS-governed execution surface"
read_when:
  - Running OpenClaw under an external ACOS control plane
  - Containing channel, Gateway, cron, shell, or patch entry points
title: "ACOS controlled mode"
---

ACOS controlled mode lets an external ACOS control plane own OpenClaw task dispatch and approval decisions. It is off by default. Existing OpenClaw CLI, Gateway, channel, cron, and tool behavior is unchanged unless controlled mode is enabled.

Enable controlled mode with either environment flag:

```bash
OPENCLAW_ACOS_CONTROLLED=1
# or
OPENCLAW_DISABLE_AUTONOMOUS_INTAKE=1
```

When controlled mode is enabled, OpenClaw rejects unmanaged agent execution. ACOS-dispatched work must provide task provenance:

```json
{
  "acos_dispatch": true,
  "dispatcher": "acos",
  "acos_task_id": "task-123",
  "run_id": "run-123",
  "queue_id": "queue-123",
  "dispatched_at": "2026-06-06T00:00:00.000Z",
  "approval_granted": false,
  "approval_scope": []
}
```

The CLI can carry provenance to a Gateway process through `OPENCLAW_ACOS_PROVENANCE` JSON, or trusted internal callers can pass the same object as `acosProvenance`. Do not put credentials, tokens, or secret values in provenance metadata.

Controlled mode blocks these autonomous paths unless ACOS provenance is present:

- `openclaw agent --local` and embedded fallback agent execution
- Gateway `agent` requests
- channel inbound agent dispatch, including Telegram inbound messages
- cron-created isolated agent turns, including already-stored jobs when they fire

Diagnostic mode is intentionally narrow. `OPENCLAW_ACOS_DIAGNOSTIC_MODE=1` or `diagnosticMode: true` permits only non-mutating checks. It does not allow shell execution, patch application, repo mutation, external sends, webhook-triggered execution, or cron-triggered execution.

Dangerous tools require explicit approval metadata in controlled mode:

- shell `exec`
- `apply_patch`

Set `approval_granted: true` and include the relevant action in `approval_scope`, for example `["shell_exec", "apply_patch"]`, only after ACOS approval. Without that approval metadata, OpenClaw rejects the tool call before execution.

Safe operating rule: when controlled mode is enabled, leave Telegram, Gateway, webhook, and cron intake running only if ACOS is prepared to provide provenance and approvals for work that should execute. Otherwise these paths should be treated as status-only or rejection-only surfaces.
