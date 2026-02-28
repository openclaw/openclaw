# OpenClaw Subagent Routing (Phase 2)

Use OpenClaw's native subagent workflow instead of building a new scheduler.

## Routing Contract

Main agent responsibilities:

1. Parse incoming DingTalk request into task JSON.
2. Resolve target machine (`agentId`) and platform capability (`mac` or `win`).
3. Dispatch to target via subagent/session spawn.
4. Collect normalized execution output and return to requester.

Target subagent responsibilities:

1. Receive task JSON.
2. Run local script:
   - `node skills/psd-automator/scripts/run-task.js --task <task.json>`
3. Return full stdout/stderr summary and machine-readable JSON result.

## Suggested Result Envelope

```json
{
  "taskId": "task-001",
  "agentId": "design-mac-01",
  "platform": "mac",
  "status": "success",
  "code": "OK",
  "resolvedPath": "/Projects/Campaign/poster.psd",
  "backupPath": "/Projects/Campaign/poster.psd.bak.20260227-140102",
  "durationMs": 4210,
  "auditLogPath": "~/.openclaw/psd-automator/audit.log"
}
```

## Guardrails

- Always attempt `dryRun` first for untrusted input.
- Enforce sender allowlists before dispatch.
- Keep one write task per PSD at a time.
- Always include `taskId` for traceability.
