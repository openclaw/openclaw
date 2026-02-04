# AgentShield Approval UX

## Overview

When AgentShield flags a tool call as requiring operator approval, the system:

1. Returns `"approval-pending"` immediately to the agent.
2. Stores encrypted tool-call args in a retry store on disk.
3. Sends an approval request through the gateway (and optional forwarder).
4. On approval, the operator can retry the exact tool call.
5. CLI commands allow listing, approving, denying, and retrying pending calls.

## Feature Gate

The feature is **entirely disabled** unless:

```
AGENTSHIELD_APPROVALS_ENABLED=1
```

When disabled, tool wrappers pass through unchanged and no gateway methods are activated.

## Security Model

- **Raw tool args are never logged, forwarded, or stored in the approval manager.**
  Only a SHA-256 `argsFingerprint` (computed from canonical JSON) appears in gateway broadcasts, forwarder messages, and manager records.
- **Encrypted at-rest storage** uses AES-256-GCM with a machine-local key.
  - Key: `{stateDir}/agentshield-retries/.key` (32 random bytes, mode `0o600`).
  - Data: `{stateDir}/agentshield-retries/{id}.enc` (mode `0o600`).
- **Single-computation invariant**: the canonical params JSON is computed once and used for both fingerprinting and retry-store encryption, ensuring the fingerprint always corresponds to the exact args that will be retried.

## Architecture

### Tool Wrapper (`pi-tools.agentshield.ts`)

Wraps each tool in the composition chain (between `normalizeToolParameters` and `wrapToolWithBeforeToolCallHook`). On execution:

1. Calls the original tool.
2. Inspects the result for `action: "needs_approval"` or `action: "needs-approval"` in `details` or parsed `content[].text` JSON.
3. If approval is needed, returns an `approval-pending` result with the canonical `paramsJSON`.

### Approval Manager (`agentshield-approval-manager.ts`)

In-memory promise-based manager (mirrors `ExecApprovalManager`):

- `create(payload, timeoutMs, id?)` — creates a pending record with `argsFingerprint`.
- `waitForDecision(record, timeoutMs)` — returns a promise that resolves to the operator decision or `null` on timeout.
- `resolve(id, decision)` — resolves the pending promise.
- `getSnapshot(id)` / `listPending()` — query pending records.

### Retry Store (`agentshield-retry-store.ts`)

Encrypted file-based store for tool-call args:

- `store(id, toolName, params, ctx?)` — encrypts and writes to disk, returns `argsFingerprint`.
- `load(id)` — decrypts and returns `{ toolName, params, ctx }`.
- `remove(id)` — deletes the encrypted file.
- `listIds()` — lists all pending retry entry IDs.

### Gateway Handlers (`server-methods/agentshield-approval.ts`)

Three RPC methods (scope: `operator.approvals`):

| Method | Description |
|--------|-------------|
| `agentshield.approval.request` | Validate, create record, store encrypted args, broadcast `agentshield.approval.requested`, forward, await decision |
| `agentshield.approval.resolve` | Validate decision, resolve in manager, broadcast `agentshield.approval.resolved`, forward |
| `agentshield.approval.list` | Return all pending approval snapshots |

### Forwarder (`agentshield-approval-forwarder.ts`)

Config-driven forwarding (via `cfg.approvals?.agentshield`). Sends approval requests and resolutions to configured channel targets. Messages contain only fingerprints, never raw args.

## Configuration

In `openclaw.yaml`:

```yaml
approvals:
  agentshield:
    enabled: true
    targets:
      - channel: slack
        to: "#ops-approvals"
```

## CLI Usage

```bash
# List pending approvals
openclaw agentshield-approvals list

# Approve or deny a pending call
openclaw agentshield-approvals approve <id> allow-once
openclaw agentshield-approvals approve <id> allow-always
openclaw agentshield-approvals approve <id> deny

# Retry a stored tool call
openclaw agentshield-approvals retry <id>
```

## Gateway Events

| Event | Payload |
|-------|---------|
| `agentshield.approval.requested` | `{ id, toolName, argsFingerprint, agentId, sessionKey, expiresAtMs }` |
| `agentshield.approval.resolved` | `{ id, decision }` |
