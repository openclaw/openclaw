# AgentShield Integration

AgentShield enforces runtime policy on every tool call in OpenClaw.
When enabled, each tool execution is evaluated against a policy profile
before it runs. Blocked tools return an error to the agent; tools
requiring approval pause until an operator grants permission.

## Quick start

### 1. Install AgentShield

```bash
pip install agentshield
# or from source:
cd /path/to/Agentshield && pip install -e ".[dev]"
```

### 2. Generate signer keys

```bash
mkdir -p data/agentshield/keys
agentshield keygen --out-dir data/agentshield/keys
```

Or let OpenClaw generate them automatically on first use (keys are
written to `data/agentshield/keys/`).

### 3. Enable the middleware

Set the environment variable:

```bash
export AGENTSHIELD_ENABLED=1
```

That's it. OpenClaw will now evaluate every tool call against the
`normal` policy profile before execution.

## Configuration

All settings are environment variables with sensible defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTSHIELD_ENABLED` | `0` | Set to `1` to enable enforcement |
| `AGENTSHIELD_POLICY_PROFILE` | `normal` | Policy profile: `normal`, `strict`, or `experimental` |
| `AGENTSHIELD_DATA_DIR` | `data/agentshield` | Base directory for all AgentShield data |
| `AGENTSHIELD_KEY_PATH` | `<data_dir>/keys/agentshield_ed25519.key` | Path to signer private key |
| `AGENTSHIELD_PUBKEY_PATH` | `<data_dir>/keys/agentshield_ed25519.pub` | Path to signer public key |
| `AGENTSHIELD_RECEIPTS_DIR` | `<data_dir>/receipts` | Decision receipts output |
| `AGENTSHIELD_INCIDENTS_ROOT` | `<data_dir>/incidents` | Incident store root |
| `AGENTSHIELD_APPROVALS_DIR` | `<data_dir>/approvals` | Approval request/grant files |
| `AGENTSHIELD_PYTHON` | `python3` | Python binary for middleware |
| `AGENTSHIELD_MIDDLEWARE_PATH` | `security/agentshield_middleware.py` | Path to middleware script |
| `AGENTSHIELD_AGENT_ID` | `openclaw-agent` | Agent ID for receipts |
| `AGENTSHIELD_PUBLISHER_ID` | `openclaw` | Publisher ID for receipts |
| `AGENTSHIELD_VERSION` | `0.0.0` | Agent version for receipts |

## Policy profiles

AgentShield ships three built-in profiles:

| Profile | Network | FS writes | Denylist | Approval gates |
|---------|---------|-----------|----------|----------------|
| `normal` | allowed (domain allowlist) | artifacts, outputs | shell_exec, code_exec | none |
| `strict` | denied | artifacts only | shell_exec, code_exec | filesystem_write |
| `experimental` | allowed (no domain check) | artifacts, outputs, workspace | none | none |

Change the profile:

```bash
export AGENTSHIELD_POLICY_PROFILE=strict
```

## How it works

```
Agent requests tool_call(tool, args)
         |
         v
  wrapToolWithBeforeToolCallHook()
         |
         v
  ┌─────────────────────────┐
  │  AgentShield middleware  │
  │  (Python subprocess)    │
  │                         │
  │  1. Build request       │
  │  2. Redact args         │
  │  3. Evaluate policy     │
  │  4. Sign receipt        │
  │  5. Return verdict      │
  └─────────────────────────┘
         |
    ┌────┼────────────┐
    v    v             v
  ALLOW  BLOCK     NEEDS_APPROVAL
    |      |             |
 execute  throw       throw
 tool    Error        Error +
           +          approval
         incident     request
         ingest       path
```

### Where artifacts are stored

```
data/agentshield/
  keys/
    agentshield_ed25519.key    # Private signing key (DO NOT COMMIT)
    agentshield_ed25519.pub    # Public key
  receipts/
    <request_id>.decision.json # Signed decision receipt per tool call
  incidents/
    incidents.jsonl            # Append-only incident log (hash-chained)
    meta.json                  # Store metadata
    receipts/                  # Copies of incident-triggering receipts
  approvals/
    <request_id>.approval_request.json
    <request_id>.approval_grant.json
```

## Approval flow

When a tool call returns `needs_approval`:

1. The agent receives an error message with the approval request path.

2. An operator reviews and signs a grant:

   ```bash
   agentshield approve \
     --request data/agentshield/approvals/<id>.approval_request.json \
     --out data/agentshield/approvals/<id>.approval_grant.json \
     --key operator.key \
     --pubkey operator.pub \
     --operator-id operator-name
   ```

3. The agent retries the tool call. On re-evaluation with the grant
   present, the middleware upgrades the decision to `allow`.

> **Note:** The current integration evaluates each call independently.
> Grant-based re-evaluation requires passing the grant path, which is
> not yet wired into the retry flow. This is planned for a future PR.

## Fail-open behavior

If the middleware fails (Python not installed, keys missing, timeout),
the tool call is **allowed** by default. This prevents AgentShield
misconfiguration from breaking the gateway.

To verify the middleware is working:

```bash
python security/agentshield_middleware.py \
  --tool http_fetch \
  --args '{"url":"https://example.com"}' \
  --key data/agentshield/keys/agentshield_ed25519.key \
  --pubkey data/agentshield/keys/agentshield_ed25519.pub \
  --policy-profile normal
```

## Smoke test

Run the bundled smoke test to verify all scenarios:

```bash
python examples/agentshield_middleware_smoke.py
```

This exercises allowed, blocked, and needs_approval paths without
touching the gateway.

## Security notes

- **Args are never logged raw.** The middleware builds a redacted
  `args_summary` string; secrets (API keys, tokens, passwords) are
  replaced with `<REDACTED>` before any storage.
- **Keys should not be committed.** Add `data/agentshield/keys/` to
  `.gitignore`.
- **Receipts are signed.** Every decision receipt is signed with
  Ed25519 and can be independently verified.
