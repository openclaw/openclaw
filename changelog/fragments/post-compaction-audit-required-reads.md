## Request
Make post-compaction required reads configurable instead of hardcoded.

## Context
Current runtime default includes `WORKFLOW_AUTO.md`, which can produce warning noise in workspaces that do not use that file.

## Proposal
- Add optional config for post-compaction audit:
  - `hooks.postCompactionAudit.enabled?: boolean`
  - `hooks.postCompactionAudit.requiredReads?: string[]`
- Keep current default behavior when config is absent (backward compatible).

## Tracking
- Related issue: https://github.com/openclaw/openclaw/issues/33792
