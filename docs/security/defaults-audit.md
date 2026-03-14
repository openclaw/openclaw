# Security Defaults Audit

**Author:** Sentinel (subagent)  
**Date:** 2026-03-11  
**Scope:** OpenClaw default security posture analysis

## Executive Summary

OpenClaw's security posture is **largely fail-closed by design**. Key defaults (`exec.security: deny` in sandbox, `sendPolicy.default: deny`, browser routing deny-by-default, DM pairing) demonstrate a security-first philosophy. However, several configuration items could be tightened further.

## Current Fail-Closed Defaults (Verified ✅)

| Setting | Default | Verdict |
|---------|---------|---------|
| `tools.exec.security` (sandbox) | `deny` | ✅ Fail-closed |
| `tools.exec.security` (gateway+node) | `allowlist` | ⚠️ Implicit allowlist |
| `sendPolicy.default` | `deny` | ✅ Fail-closed |
| DM security | `pairing` (code approval) | ✅ Fail-closed |
| Browser screenshot routing | deny-by-default | ✅ Fail-closed |
| HTTP tools invoke | hard deny list applied | ✅ Fail-closed |
| `security.allowRemoteViewer` | `false` | ✅ Fail-closed |
| Group policy (BlueBubbles etc.) | `allowlist` | ✅ Fail-closed |

## Recommendations: 5 Items That Should Default Safer

### 1. Exec Security Mode (Gateway/Node)

| Aspect | Value |
|--------|-------|
| **Current default** | `allowlist` (when unset on gateway+node) |
| **Suggested default** | `deny` (require explicit opt-in to allowlist) |
| **Risk level** | 🔴 HIGH |
| **Rationale** | Allowlist still permits pre-approved commands. A new deployment with no allowlist configured effectively allows everything matching default patterns. `deny` forces conscious configuration. |

### 2. PII Redaction in Logs

| Aspect | Value |
|--------|-------|
| **Current default** | No automatic PII redaction in session/exec logs |
| **Suggested default** | Enable structured PII redaction (emails, phone numbers, API keys) |
| **Risk level** | 🟡 MEDIUM |
| **Rationale** | Logs persist to disk. Agent conversations routinely contain user PII (names, emails, calendar data). GDPR/privacy compliance requires redaction-by-default. |

### 3. Webhook Agent Routing Allowlist

| Aspect | Value |
|--------|-------|
| **Current default** | `hooks.allowedAgentIds` omitted = allow any agent via `agentId` param |
| **Suggested default** | `hooks.allowedAgentIds: []` (deny all explicit routing unless configured) |
| **Risk level** | 🟡 MEDIUM |
| **Rationale** | An unconfigured webhook endpoint allows arbitrary agent selection. Default-deny prevents lateral movement across agent boundaries. |

### 4. Memory Cross-Session Access

| Aspect | Value |
|--------|-------|
| **Current default** | `memory.policy.default: "deny"` (documented) but no runtime enforcement layer cited |
| **Suggested default** | Enforce deny at runtime with audit log when cross-session memory access is attempted |
| **Risk level** | 🟡 MEDIUM |
| **Rationale** | Policy-as-config without runtime enforcement is a paper lock. Memory isolation is critical for multi-agent deployments. |

### 5. Subagent File Access Scope

| Aspect | Value |
|--------|-------|
| **Current default** | Subagents inherit parent workspace directory automatically |
| **Suggested default** | Subagents get read-only workspace access; write requires explicit `sandbox: "require"` |
| **Risk level** | 🟠 MEDIUM-HIGH |
| **Rationale** | A compromised or misbehaving subagent can modify AGENTS.md, SOUL.md, or other control files. Read-only default preserves integrity of the orchestration layer. |

## Summary Matrix

| # | Config Item | Current | Suggested | Risk |
|---|------------|---------|-----------|------|
| 1 | exec security (gw/node) | allowlist | deny | 🔴 HIGH |
| 2 | PII log redaction | off | on | 🟡 MEDIUM |
| 3 | Webhook agent routing | allow-all | deny-all | 🟡 MEDIUM |
| 4 | Memory cross-session | config-only deny | runtime-enforced deny | 🟡 MEDIUM |
| 5 | Subagent file access | read-write inherit | read-only default | 🟠 MED-HIGH |

---

## Research Context

**Immune System Analogy: Default Defense Posture (默认防御姿态)**

A healthy immune system is **constitutively active** — it doesn't wait for infection to start defending. Innate immunity (skin barriers, mucous membranes, complement system) operates deny-by-default: everything foreign is blocked unless explicitly recognized as self.

OpenClaw's security defaults should mirror this: **every surface defaults to deny**, and operators explicitly open pathways they need. The five recommendations above identify places where the "mucosal barrier" has gaps — not active vulnerabilities, but places where the default posture assumes trust rather than requiring proof of it.

The key principle: **fail-closed is not a feature to add; it's the absence of fail-open to remove.**
