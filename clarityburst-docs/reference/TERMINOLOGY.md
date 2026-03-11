# Quick Reference: ClarityBurst Terminology Guide

**Purpose:** Ensure consistent terminology across ClarityBurst documentation  
**Date:** March 5, 2026  
**Status:** ✅ Ready for use

---

## One-Page Summary

### ClarityBurst is...

✅ **"Deterministic Execution Control Plane"**
- Primary term for the system
- Emphasizes: deterministic decisions, execution-focused, control-plane architecture

### ClarityBurst is NOT...

❌ **"AI Governance System"**
- Not a policy enforcement system
- Not a business approval workflow
- Not permission/role management

---

## Quick Terminology Reference

### Use These Terms

| Term | When to Use | Example |
|------|-------------|---------|
| **Deterministic execution control plane** | Primary description of ClarityBurst | "ClarityBurst is a deterministic execution control plane" |
| **Deterministic arbitration** | Describing decision-making | "ClarityBurst performs deterministic arbitration of contract rules" |
| **Execution commit** | Describing the gating mechanism | "The execution commit gate decides APPROVE/DENY/BLOCK" |
| **Fail-closed semantics** | Describing safety behavior | "ClarityBurst implements fail-closed semantics: deny when uncertain" |
| **Audit trail** | Describing logging | "Complete audit trail of every decision" |
| **Dominance** | Explaining when execution is safe | "If dominance between candidate actions cannot be established, block" |

### Avoid These Terms (for ClarityBurst)

| Term | Why Not | Better Alternative |
|------|---------|-------------------|
| **Governance system** | Implies policy/rules | "Control plane" or "arbitration layer" |
| **AI governance** | Implies organizational control | "Deterministic execution control plane" |
| **Policy governance** | Implies business rules | "Contract-based routing" |
| **Permission management** | Implies role-based access | "Privilege operation gating" |
| **Approval workflow** | Implies human decision | "Deterministic arbitration" |

---

## Architecture Boundary (to include in docs)

```
LLM reasoning
  → Agent planning
  → ClarityBurst deterministic arbitration ← HERE IS THE GATE
  → Execution commit (atomic decision)
  → System operations
```

**Key Point:** Decision happens BEFORE side effects are committed

---

## The Critical Rule (to include in comments)

> ClarityBurst performs deterministic arbitration before execution.
> If dominance between candidate actions cannot be established,
> no decision is made and execution is blocked.

---

## Documentation Checklist

When writing about ClarityBurst, include:

- [ ] "Deterministic execution control plane" in description
- [ ] Architecture boundary diagram (LLM → Agent → ClarityBurst → System)
- [ ] Execution timing clarification (decision BEFORE side effects)
- [ ] Dominance concept explanation
- [ ] Fail-closed behavior explanation
- [ ] Link to `CLARITYBURST_ARCHITECTURE_BOUNDARIES.md`

---

## For Code Comments

**Good example:**
```typescript
// ClarityBurst performs deterministic arbitration before execution commit.
// If dominance between candidate actions cannot be established,
// no decision is made and execution is blocked (fail-closed).
```

**Poor example:**
```typescript
// This is our governance layer that enforces policies
```

---

## For Executive Summaries

**Good example:**
"ClarityBurst is a deterministic execution control plane that makes safety-critical
routing decisions before agent code executes. If action dominance cannot be established,
execution is blocked."

**Poor example:**
"ClarityBurst is our AI governance system."

---

## Reference Documents

- **Comprehensive Guide:** `docs/CLARITYBURST_ARCHITECTURE_BOUNDARIES.md`
- **Complete Update:** `REPOSITORY_DOCUMENTATION_UPDATE_COMPLETE.md`
- **Verification Results:** `DOCUMENTATION_UPDATE_VERIFICATION.md`

---

## Version History

| Date | Status | Notes |
|------|--------|-------|
| March 5, 2026 | ✅ Current | Terminology audit complete, all tests pass |

---

**Keep this guide handy when writing ClarityBurst documentation!**
