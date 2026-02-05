# AgentShield Approval UX

## Overview

When AgentShield flags a tool call as requiring operator approval, the system:

1. Returns `"approval-pending"` immediately to the agent.
2. Stores encrypted tool-call args in a retry store on disk.
3. Persists an approval request record (metadata only, no raw args).
4. Sends an approval request through the gateway (and optional forwarder).
5. On approval, the operator can retry the exact tool call.
6. CLI commands allow listing, approving, denying, and retrying pending calls.

## Feature Gate

The feature is **entirely disabled** unless:

```
AGENTSHIELD_APPROVALS_ENABLED=1
```

When disabled:
- Tool wrappers pass through unchanged
- No gateway methods are activated
- CLI commands return a clear "approvals disabled" error
- No state is persisted

## Security Model

- **Raw tool args are never logged, forwarded, or stored in approval records.**
  Only a SHA-256 `argsFingerprint` (computed from canonical JSON) appears in gateway broadcasts, forwarder messages, and approval records.
- **Encrypted at-rest storage** for retry data uses AES-256-GCM with a machine-local key.
  - Key: `{stateDir}/agentshield-retries/.key` (32 random bytes, mode `0o600`).
  - Data: `{stateDir}/agentshield-retries/{id}.enc` (mode `0o600`).
- **Approval records** store only safe metadata (fingerprints, tool names, timestamps).
- **Single-computation invariant**: the canonical params JSON is computed once and used for both fingerprinting and retry-store encryption, ensuring the fingerprint always corresponds to the exact args that will be retried.

## Operator Workflow

### 1. A Tool Call Requires Approval

When a tool call is blocked, the agent receives a response like:

```json
{
  "status": "approval-pending",
  "tool": "file_write",
  "approvalId": "a1b2c3d4-...",
  "message": "Tool call requires AgentShield approval. Awaiting operator decision."
}
```

### 2. List Pending Approvals

```bash
# List all approvals
openclaw agentshield-approvals list

# Filter by status
openclaw agentshield-approvals list --status pending
openclaw agentshield-approvals list --status approved
openclaw agentshield-approvals list --status denied

# Limit results
openclaw agentshield-approvals list --limit 10
```

Output:
```
AgentShield Approvals
ID           Tool          Agent   Status    Age
a1b2c3d4     file_write    test    pending   2m
e5f6g7h8     http_post     prod    approved  1h
```

### 3. View Approval Details

```bash
openclaw agentshield-approvals view <id>
```

Output:
```
ID:          a1b2c3d4-5e6f-7g8h-9i0j-k1l2m3n4o5p6
Tool:        file_write
Agent:       test-agent
Session:     session-123
Fingerprint: abc123def456...
Created:     1/15/2025, 10:30:00 AM
Expires:     1/15/2025, 10:32:00 AM
Status:      pending

Commands:
  openclaw agentshield-approvals decide a1b2c3d4 --decision allow-once
  openclaw agentshield-approvals decide a1b2c3d4 --decision allow-always
  openclaw agentshield-approvals decide a1b2c3d4 --decision deny
```

### 4. Make a Decision

```bash
# Allow once (single execution)
openclaw agentshield-approvals decide <id> --decision allow-once

# Allow always (add to allowlist)
openclaw agentshield-approvals decide <id> --decision allow-always --reason "Trusted operation"

# Deny
openclaw agentshield-approvals decide <id> --decision deny --reason "Suspicious activity"
```

### 5. Retry the Tool Call

After approving, retry the original tool call:

```bash
openclaw agentshield-approvals retry <id>
```

If retry data is available, the tool will be re-executed when the agent resumes.

## Decision Types

### allow-once

- Allows a single execution of the tool call
- The decision is consumed after one successful retry
- Use for one-time operations

### allow-always

- Adds the `argsFingerprint` to the allowlist
- Future tool calls with the same fingerprint auto-allow
- Use for trusted, repeatable operations

### deny

- Blocks the tool call
- The request is marked as denied
- Cannot be retried

## Allowlist Management

The allowlist stores fingerprints of approved tool calls for `allow-always` decisions.

```bash
# List allowlist entries
openclaw agentshield-approvals allowlist list

# Remove an entry
openclaw agentshield-approvals allowlist remove <fingerprint>
```

## Storage Structure

```
~/.openclaw/agentshield/
├── approvals/
│   ├── requests/
│   │   └── <id>.json       # Approval request metadata
│   └── decisions/
│       └── <id>.json       # Operator decisions
├── allowlist.json          # Fingerprint allowlist
└── retries/
    ├── .key                # AES-256 encryption key
    └── <id>.enc            # Encrypted tool args
```

## Architecture

### Tool Wrapper (`pi-tools.agentshield.ts`)

Wraps each tool in the composition chain. On execution:

1. Calls the original tool.
2. Inspects the result for `action: "needs_approval"` or `action: "needs-approval"`.
3. If approval is needed, returns an `approval-pending` result with the canonical `paramsJSON`.

### Approval Manager (`agentshield-approval-manager.ts`)

In-memory promise-based manager:

- `create(payload, timeoutMs, id?)` — creates a pending record with `argsFingerprint`.
- `waitForDecision(record, timeoutMs)` — returns a promise that resolves to the operator decision or `null` on timeout.
- `resolve(id, decision)` — resolves the pending promise.

### Approval Store (`agentshield-approval-store.ts`)

Disk-based persistence for approval records:

- `storeRequest(record)` — saves request metadata (no raw args).
- `loadRequest(id)` — retrieves a request by ID.
- `storeDecision(record)` — saves operator decision and updates request status.
- `listRequests(opts?)` — lists requests with optional status filter.

### Allowlist (`agentshield-allowlist.ts`)

Fingerprint-based allowlist for `allow-always` decisions:

- `isAllowed(fingerprint)` — checks if fingerprint is in allowlist.
- `add(entry)` — adds fingerprint with metadata.
- `remove(fingerprint)` — removes from allowlist.

### Retry Store (`agentshield-retry-store.ts`)

Encrypted file-based store for tool-call args:

- `store(id, toolName, params, ctx?)` — encrypts and writes to disk.
- `load(id)` — decrypts and returns `{ toolName, params, ctx }`.
- `remove(id)` — deletes the encrypted file.

### Gateway Handlers (`server-methods/agentshield-approval.ts`)

Three RPC methods (scope: `operator.approvals`):

| Method | Description |
|--------|-------------|
| `agentshield.approval.request` | Create record, store encrypted args, broadcast, await decision |
| `agentshield.approval.resolve` | Resolve decision, broadcast, update allowlist |
| `agentshield.approval.list` | Return all pending approval snapshots |

### Forwarder (`agentshield-approval-forwarder.ts`)

Config-driven forwarding via `cfg.approvals?.agentshield`. Sends approval requests and resolutions to configured channel targets. Messages contain only fingerprints, never raw args.

## Configuration

In `openclaw.yaml`:

```yaml
approvals:
  agentshield:
    enabled: true
    targets:
      - channel: slack
        to: "#ops-approvals"
      - channel: telegram
        to: "@admin"
```

## CLI Reference

```bash
# List approvals
openclaw agentshield-approvals list [--status <status>] [--limit <n>] [--json]

# View approval details
openclaw agentshield-approvals view <id> [--json]

# Make a decision
openclaw agentshield-approvals decide <id> --decision <decision> [--reason <reason>] [--json]

# Retry approved tool call
openclaw agentshield-approvals retry <id> [--json]

# Allowlist management
openclaw agentshield-approvals allowlist list [--json]
openclaw agentshield-approvals allowlist remove <fingerprint> [--json]

# Deprecated (use 'decide' instead)
openclaw agentshield-approvals approve <id> <decision>
```

## Gateway Events

| Event | Payload |
|-------|---------|
| `agentshield.approval.requested` | `{ id, toolName, argsFingerprint, agentId, sessionKey, expiresAtMs }` |
| `agentshield.approval.resolved` | `{ id, decision, resolvedBy, ts }` |

## Troubleshooting

### "Retry data not available"

The encrypted tool args were not stored or have been cleaned up. The tool call must be re-initiated by the agent.

### "Approvals disabled"

Set `AGENTSHIELD_APPROVALS_ENABLED=1` to enable the feature.

### Gateway not running

The CLI can still show persisted approvals even when the gateway is offline. However, real-time pending approvals require the gateway to be running.
