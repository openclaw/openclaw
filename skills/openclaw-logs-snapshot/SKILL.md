---
name: openclaw-logs-snapshot
description: Capture and summarize recent OpenClaw logs for incident triage. Use when users ask what failed recently, need quick error context, or want a concise failure summary with next actions.
---

# OpenClaw Logs Snapshot

Collect recent logs and return an actionable summary.

## Collect logs

Start with:

```bash
openclaw logs
```

If available in environment, scope to recent window and relevant service output.

## Snapshot workflow

1. Capture recent error/warn entries.
2. Identify repeating error signatures.
3. Correlate with gateway/channel status checks.
4. Produce top 1-3 probable causes.

## Suggested companion checks

```bash
openclaw status
openclaw health --json
openclaw gateway status
```

## Output format

Return:

- time window reviewed
- top error signatures (bullet list)
- probable cause per signature
- next command to validate/fix each cause

## Guardrails

- Redact secrets/tokens from pasted log lines.
- Do not spam raw logs unless explicitly requested.
- Prioritize concise summary over long transcript dumps.
