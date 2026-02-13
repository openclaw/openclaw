# Security Threat Model (AppSec + Policy Enforcement)

## 1) Threats unique to AI-first dispatch
### T1: Prompt injection to force unauthorized actions
- User messages attempt to override tool constraints or request hidden tools.

**Mitigations**
- Closed toolset allowlist (tool bridge)
- Server-side authz in dispatch-api; reject unauthorized actor/tool/state combos
- Never pass raw tool execution logs back to user without redaction
- Treat inbound text as untrusted; AI suggestions are not actions.

### T2: Hallucinated confirmations
- Agent says “scheduled” without actually mutating state.

**Mitigations**
- Only dispatch-api responses can generate customer confirmations
- UI/messages reference authoritative state (GET /ticket) after mutation

### T3: Channel spoofing / social engineering
- Attacker pretends to be store manager to approve NTE.

**Mitigations**
- Authorized contact list per site/account
- 2nd-factor confirmation for high-risk approvals (v1)
- Approval workflow: identity verification steps by channel

### T4: Tool invocation abuse (internal)
- Compromised service account calls dispatch-api directly.

**Mitigations**
- mTLS or signed JWT between tool bridge and dispatch-api
- Least-privilege service accounts; per-environment keys
- Request signing + replay protection (nonce/exp)

### T5: Data exfiltration via logs / prompts
- Sensitive customer data appears in logs or model context.

**Mitigations**
- Structured logging with redaction rules
- Separate “agent context store” from PII store; PII minimization
- Avoid dumping full ticket payloads into model prompts; use summaries

## 2) AuthN/AuthZ plan (v0)
- Tool bridge authenticates as a service identity to dispatch-api
- User identity is carried as signed claims in headers
- dispatch-api authorizes:
  - actor role
  - ticket ownership / account membership
  - tool name
  - state transition validity

## 3) Input validation
- Strict schemas for every command endpoint
- Reject unknown fields by default (or store under metadata with caution)
- Enforce required evidence keys per incident type

## 4) Audit + forensics
- audit_events is append-only
- correlation_id ties together: inbound message → agent → tool call → dispatch-api mutation
- include trace_id if using OpenTelemetry

## 5) Secure defaults
- “Fail closed” on any ambiguity:
  - missing idempotency key
  - missing role
  - invalid transition
  - missing evidence

