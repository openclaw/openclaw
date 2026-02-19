# Orchestration + Plugins MVP (Phase 4)

This document describes the baseline orchestration/plugin controls added in the Phase 4 MVP.

## Plugin manager MVP

Implemented in `src/orchestration/plugin-manager.ts`.

Capabilities:

- Discovery/listing via existing plugin discovery paths (`discoverOpenClawPlugins`)
- Enable/disable lifecycle wrappers:
  - `enable(...)` -> updates `plugins.entries.<id>.enabled=true`
  - `disable(...)` -> updates `plugins.entries.<id>.enabled=false`
- Basic compatibility checks (`checkPluginCompatibility`):
  - Optional `platformContract` match (`openclaw.plugin-api`)
  - Optional minimum platform version (`platformMinVersion`, semver-like)

## Queueing + orchestration baseline

Implemented in `src/orchestration/job-queue.ts`.

- Job state model: `queued | running | succeeded | failed | blocked | skipped`
- Clear status surfaces:
  - `getStatus(jobId)`
  - `listStatus()`
- Idempotency/retry-safe baseline:
  - Dedupe by `key` at enqueue time while active (`queued`/`running`)
  - Retry up to `maxAttempts`

## Policy checks baseline

Implemented in `src/orchestration/policy-gates.ts`.

- High-risk actions require explicit role gate (`admin`+ by default):
  - `plugin.install`, `plugin.uninstall`, `plugin.enable`, `plugin.disable`, `orchestration.run`
- Blocked actions throw `PolicyBlockedError` with user-facing error text.
- Blocked actions can emit audit entries (`policy.blocked`).

## Audit trail baseline

Implemented in `src/orchestration/audit-trail.ts`.

- Append-only JSONL audit stream.
- Structured event fields: `ts`, `type`, `actor`, `pluginId`, `jobId`, `action`, `reason`, `meta`.
- Event coverage includes plugin lifecycle, policy blocks, and orchestration job transitions.

## Troubleshooting

- **Plugin compatibility rejected:**
  - Verify plugin `openclaw` package metadata:
    - `platformContract: "openclaw.plugin-api"`
    - `platformMinVersion` not newer than host runtime
- **Action blocked by policy:**
  - Elevate actor role to `admin` or `owner`
  - Confirm action is expected high-risk and intentionally gated
- **Missing audit events:**
  - Ensure `auditFilePath` is configured when constructing orchestration helpers

## Tests

Targeted tests live in:

- `src/orchestration/plugin-manager.test.ts`

Coverage includes:

- plugin enable/disable lifecycle behavior
- compatibility check success/failure
- policy block flow + audit entry emission
