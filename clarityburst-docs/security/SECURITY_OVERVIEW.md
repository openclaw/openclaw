# ClarityBurst Security Overview

**Security model, threat landscape, and fail-closed guarantees**

---

## Executive Summary

ClarityBurst is a **fail-closed decision gating framework** designed to prevent unsafe operations and cost explosions through deterministic routing and confirmation gates.

**Core Security Properties:**

1. ✅ **Fail-Closed on Router Outage** – Defaults to ABSTAIN (block) when router unavailable
2. ✅ **Explicit User Confirmation** – High-risk operations require exact token match
3. ✅ **Runaway Loop Prevention** – Detects and blocks repeated high-risk actions
4. ✅ **Module Boundary Enforcement** – Raw primitives only accessible through gating wrappers
5. ✅ **Comprehensive Tripwire Tests** – 30+ tests verify fail-closed behavior

---

## Security Model

### Trust Boundaries

```
┌─────────────────────────────────────┐
│  Untrusted Agent Code               │  May attempt unsafe operations
├─────────────────────────────────────┤
│  ClarityBurst Gating Layer          │  Decision enforcement point
├─────────────────────────────────────┤
│  External ClarityBurst Router       │  Trusted arbitration service
├─────────────────────────────────────┤
│  Protected Primitives               │  Shell, network, filesystem
│  (Only reachable through gating)    │
└─────────────────────────────────────┘
```

### Threat Model

ClarityBurst protects against:

| Threat | Attack Vector | Mitigation |
|--------|---------------|-----------|
| **Runaway Loops** | Agent repeatedly executes same high-risk action (e.g., network call) in a loop | Detection + intervention; cost prevention |
| **Unauthorized Primitive Access** | Code directly calls shell/network/fs APIs, bypassing gating | Module boundary enforcement; approved importers only |
| **Router Unavailability** | Router service is down; attacker expects fallback to "allow" | Fail-closed default; returns ABSTAIN_CLARIFY on outage |
| **Confirmation Bypass** | Attacker provides substring/partial token instead of exact match | Exact string matching enforced; no prefix/substring acceptance |
| **Pack Incompleteness** | Incomplete ontology pack loaded; missing contracts undetected | Strict validation; throw on incompleteness |
| **Configuration Injection** | Attacker injects malicious config; changes router URL or timeout | Environment variable validation; hardcoded ranges (100-5000ms) |
| **Prompt Injection** | Attacker embeds instructions in user input to override gating | Deterministic routing based on stage + context, not prompt content |

---

## Fail-Closed Behavior

ClarityBurst fails safe in all failure scenarios:

### Router Outage

**Scenario:** Router is unreachable (timeout, connection refused, malformed response)  
**Expected Behavior:** `ABSTAIN_CLARIFY` (block execution)  
**Proof:** [`shell_exec.confirmation.exact_token.tripwire.test.ts`](../../src/clarityburst/__tests__/shell_exec.confirmation.exact_token.tripwire.test.ts)

### Pack Incompleteness

**Scenario:** Ontology pack is incomplete or missing required fields  
**Expected Behavior:** Throw `ClarityBurstAbstainError` immediately (fail hard)  
**Proof:** Multiple tripwire tests, e.g., [`file_system_ops.save_session_store.pack_incomplete.fail_closed.at_commit_point.tripwire.test.ts`](../../src/clarityburst/__tests__/file_system_ops.save_session_store.pack_incomplete.fail_closed.at_commit_point.tripwire.test.ts)

### Empty Allowlist

**Scenario:** Stage has no allowed contracts (allowedContractIds is empty array)  
**Expected Behavior:** `ABSTAIN_CLARIFY` (block all operations for that stage)  
**Proof:** [`tool_dispatch_gate.empty_allowlist.abstain_clarify.tripwire.test.ts`](../../src/clarityburst/__tests__/tool_dispatch_gate.empty_allowlist.abstain_clarify.tripwire.test.ts)

### Confirmation Not Provided

**Scenario:** Operation requires confirmation; user doesn't provide token or provides substring  
**Expected Behavior:** `ABSTAIN_CONFIRM` (block until exact token provided)  
**Proof:** Exact token matching enforced; no substring acceptance

---

## Threat Intelligence Analysis

For detailed strategic threat analysis, see [`Threat Intelligence`](THREAT_INTELLIGENCE.md).

Key findings:

- **Prompt injection attacks** cannot override gating (routing is deterministic, not prompt-based)
- **Configuration injection** is prevented through validation and hardcoded ranges
- **Privilege escalation** is limited by ontology contracts (each stage has explicit capability requirements)
- **Cost explosion** is prevented through runaway loop detection (intervention by step 5)

---

## Compliance & Validation

### Audit Results

**Full Security Audit:** [`Security Audit Report`](SECURITY_AUDIT_REPORT.md)

Key findings:

- ✅ All 13 stages have gating functions
- ✅ Fail-closed behavior verified across all failure modes
- ✅ Module boundaries enforced (no unapproved imports of sink modules)
- ✅ Confirmation token matching is exact (no substring accepted)
- ✅ Router timeout is configurable but bounded (100-5000ms)

### Validation Tests

**Production Readiness Harness:** [`Verification Harness`](../validation/VERIFICATION_HARNESS.md)

7 checks:

1. **COVERAGE** – Gating functions found and used
2. **DOMINANCE_HEURISTIC** – No raw primitives outside wrappers (pattern scan)
3. **DOMINANCE_STRICT** – Module boundaries enforced (import-graph analysis)
4. **AGENTIC_LOOP_SIMULATION** – Proves safety (runaway prevention) + autonomy (task completion)
5. **OUTAGE_FAILCLOSED** – Fail-closed behavior under mock router outage
6. **OUTAGE_CHAOS_INTEGRATION** – Real router + chaos injection (jitter, timeout, schema drift)
7. **BENCHMARK_DELTAS** – Overhead measured and acceptable

---

## Configuration Security

### Environment Variables

All configuration is validated:

```bash
# Enable/disable gating
CLARITYBURST_ENABLED=true
  # Parsed as boolean; only "true"/"false" accepted
  # Default: true

# Router URL
CLARITYBURST_ROUTER_URL=http://localhost:3001
  # Validated as URL format
  # No path traversal or injection possible

# Router timeout (milliseconds)
CLARITYBURST_ROUTER_TIMEOUT_MS=1200
  # Hardcoded range: 100-5000ms
  # Values outside range rejected

# Logging level
CLARITYBURST_LOG_LEVEL=info
  # Whitelist: debug, info, warn, error
  # Unsupported values rejected
```

**No code injection possible through configuration.** See [`src/clarityburst/config.ts`](../../src/clarityburst/config.ts) for validation logic.

---

## Privilege Escalation Prevention

Each contract defines **capability requirements**:

```json
{
  "contract_id": "SHELL_EXEC:001",
  "name": "Execute arbitrary shell command",
  "risk_level": "CRITICAL",
  "requires_confirmation": true,
  "capabilities_required": ["shell", "critical_opt_in"]
}
```

Users cannot escalate privileges unless:

1. **Contract is available** in the ontology pack
2. **User has required capabilities** (evaluated by router)
3. **User confirms** the operation (with exact token match)

---

## Hardening Roadmap

Future security enhancements planned in [`Hardening Roadmap`](HARDENING_ROADMAP.md):

- Enhanced rate limiting on router calls
- Circuit breaker pattern for cascading failure prevention
- Extended audit logging with forensic trail
- Cryptographic proof of gating decisions
- And more...

---

## Security Incident Response

If a security issue is discovered:

1. **Report immediately** to the security team (do not open public issue)
2. **Verify** fail-closed behavior is maintained
3. **Patch** the affected stage gating function
4. **Re-run** production readiness verification: `pnpm clarityburst:verify`
5. **Deploy** patched version

---

## See Also

- **Detailed Audit:** [`Security Audit Report`](SECURITY_AUDIT_REPORT.md)
- **Threat Analysis:** [`Threat Intelligence`](THREAT_INTELLIGENCE.md)
- **Validation:** [`Verification Harness`](../validation/VERIFICATION_HARNESS.md)
- **Configuration:** [`Configuration Injection Validation`](CONFIGURATION_INJECTION.md)
- **Enterprise Summary:** [`Enterprise Security Summary`](ENTERPRISE_SECURITY_SUMMARY.md)

---

**Last Updated:** 2026-03-07  
**Audit Date:** 2026-02-28  
**Status:** ✅ Production-ready with fail-closed guarantees
