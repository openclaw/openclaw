# ClarityBurst: Architecture Boundaries & Terminology

**Date:** March 5, 2026  
**Purpose:** Define precise terminology and architecture boundaries for ClarityBurst deterministic execution control plane

---

## Terminology Clarification

### NOT: "AI Governance System"

ClarityBurst is **NOT** a governance system. It does not:
- Define corporate policies
- Enforce business rules
- Act as an approval workflow
- Manage organizational permissions
- Handle human decision-making workflows

### YES: "Deterministic Execution Control Plane"

ClarityBurst **IS** a deterministic execution control plane. It:
- Arbitrates between candidate agent actions using contract rules
- Makes deterministic (repeatable, auditable) decisions
- Commits execution decisions before side effects occur
- Blocks execution if action dominance cannot be established
- Records complete audit trail of each decision

**Why this terminology?**
- "Deterministic": Same input always produces same output (no probabilistic guessing)
- "Execution": Focuses on _when_ code runs (before vs. after side effects)
- "Control": System explicitly manages execution boundaries
- "Plane": Architectural layer (aircraft analogy: control surfaces manage flight)

---

## Architecture Boundary

### The Complete Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Agentic System                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. LLM Reasoning                                            │
│     ↓ (Generate candidate actions with reasoning)           │
│                                                              │
│  2. Agent Planning                                           │
│     ↓ (Select best course based on heuristics)              │
│                                                              │
│  ─────────────────────────────────────────────────────────  │
│  CLARITYBURST DETERMINISTIC ARBITRATION LAYER              │
│  ─────────────────────────────────────────────────────────  │
│     ↓ (Evaluate action dominance via contracts)             │
│                                                              │
│  3. Execution Commit Gate                                    │
│     ↓ (Atomic decision: APPROVE / DENY / BLOCK)             │
│                                                              │
│  4. System Operations                                        │
│     ↓ (Sandboxed execution with audit trail)                │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Key Characteristics

**What ClarityBurst Controls:**
- **Execution timing:** When operations execute (before vs. after LLM reasoning)
- **Execution eligibility:** Which operations get approval/denial/block
- **Execution atomicity:** All-or-nothing semantics (no partial execution)
- **Execution auditability:** Complete record of each decision

**What ClarityBurst Does NOT Control:**
- **Reasoning quality:** LLM hallucinations (if no side effects)
- **Planning correctness:** Agent heuristics (if not triggering gated operations)
- **Business logic:** Domain-specific application rules
- **Human workflows:** Approval processes or corporate governance

---

## Deterministic Arbitration: The Core Innovation

### What is Arbitration?

When an agent proposes an action, ClarityBurst evaluates:

1. **Can this action be approved?** (Check contract rules)
2. **Are there competing actions?** (Evaluate dominance)
3. **What is the safe outcome?** (Default deny if uncertain)

### Dominance: The Critical Concept

**High dominance:** Action clearly safe, approve ✅
```
Action: Read inventory from database
Contracts: INVENTORY_READ allowed
Competing: None
Result: APPROVE → Execute immediately
```

**No dominance:** Cannot determine if safe, block ❌
```
Action: INSERT INTO users (role='admin')
Contracts: WRITE_DB requires confirmation
Competing: WRITE_DB could escalate privileges
Result: BLOCK → Execute never
```

**Conditional dominance:** Safe if condition met, evaluate ✅
```
Action: POST to facebook.com
Contracts: EXTERNAL_API requires token
Competing: Router denied (auth_expired)
Result: DENY → Execute never
```

### The Critical Decision Rule

**If dominance between candidate actions cannot be established, no decision is made and execution is blocked.**

This is the fail-closed principle: When uncertain, block to prevent harm.

---

## ClarityBurst Components vs. Traditional Governance

### Traditional Governance System
```
Human establishes policy
  ↓
System checks if action matches policy
  ↓
System approves/denies
  ↓
Execute
```

**Problems:**
- Policies are often loose/ambiguous
- Approval is reactive (after agent proposes)
- Failures can be silent (approval but execution fails)
- Hard to audit "what should have happened"

### ClarityBurst Deterministic Arbitration
```
Agent proposes action
  ↓
ClarityBurst evaluates dominance (contracts)
  ↓
ClarityBurst makes deterministic decision
  ↓
Decision is committed BEFORE execution
  ↓
Execute (or block)
```

**Advantages:**
- Contracts are precise (not loose policies)
- Arbitration is proactive (before execution)
- Failures are explicit (blocked operations logged)
- Audit trail is complete (every decision recorded)

---

## The Execution Boundary Diagram

```
AGENT CODE                  │ CLARITYBURST            │ SYSTEM
─────────────────────────────────────────────────────────────

Reasoning (LLM)
  ↓
Planning (heuristic)
  ↓
Generate action proposal
  ↓
Call router (pre-execution)
  ├─────────────────────────→ Evaluate contract rules
  │                          Determine dominance
  │                          Make atomic decision
  │ ← ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ APPROVE/DENY/BLOCK
  ↓
IF decision == APPROVE:
  ├─────────────────────────────────────────────→ Execute
  │                                              Audit log
  │                                              Record outcome
  ↓
Return result
  ↓
Next iteration
```

**Key Point:** The router call is a **pre-execution gate**. The decision is made BEFORE any side effects occur.

---

## Why "Control Plane" Matters

### Aircraft Control Plane Analogy

**Fly-by-wire aircraft:**
- Pilot wants action: "Increase pitch"
- Flight control computer: "Evaluate if safe"
- Computer checks: Is pitch envelope valid? Will aircraft stall?
- Computer decides: APPROVE or DENY pitch increase
- **BEFORE actuators move control surfaces**

**ClarityBurst:**
- Agent wants action: "INSERT INTO users"
- ClarityBurst: "Evaluate if safe"
- ClarityBurst checks: Is contract satisfied? Is router available?
- ClarityBurst decides: APPROVE or DENY write
- **BEFORE database executes INSERT**

**Both are control planes because they:**
1. Make deterministic decisions before execution
2. Evaluate safety constraints (envelopes vs. contracts)
3. Fail-closed when uncertain
4. Are completely auditable

---

## Deterministic Arbitration: The Technical Definition

**ClarityBurst performs deterministic arbitration before execution commit.**

Breaking this down:

- **Deterministic:** Same input → Same output (no RNG, no probabilistic routing)
- **Arbitration:** Evaluates competing candidate actions
- **Before:** Decision happens before side effects are committed
- **Execution:** The actual system operations (database writes, API calls, shell execution)
- **Commit:** Making the decision official/irreversible

### What if Dominance Cannot be Established?

```typescript
const canApprove = (
  hasValidContract &&
  routerResponded &&
  tokenIsValid &&
  operationMatched
);

const shouldBlock = !canApprove || dominanceUncertain;

if (shouldBlock) {
  // No decision is made, execution is blocked
  // Fail-closed: deny when uncertain
  operation.status = "BLOCKED";
  auditLog.record("execution_blocked", { reason, context });
  return; // Do not execute
}
```

**This is the core security invariant:** When ClarityBurst cannot establish that an action dominates all competitors, execution is blocked.

---

## Documentation Standards

### When Describing ClarityBurst, Use:

✅ **Correct Terminology**
- "Deterministic execution control plane"
- "Deterministic arbitration layer"
- "Execution commit gate"
- "Contract-based routing"
- "Fail-closed semantics"

❌ **Avoid These Terms (for ClarityBurst)**
- "Governance system"
- "Policy enforcement"
- "Approval workflow"
- "Permission management"
- "Corporate governance"

### Architecture Description Template

When explaining ClarityBurst behavior:

```markdown
**ClarityBurst performs deterministic arbitration before execution commit.**

[Specific scenario]:
  Agent proposes: [action]
  ClarityBurst evaluates: [contract rule]
  Decision: [APPROVE/DENY/BLOCK]
  Result: [execute or block]

If dominance between candidate actions cannot be established,
no decision is made and execution is blocked.
```

---

## Summary

| Aspect | ClarityBurst | Traditional Governance |
|--------|-------------|----------------------|
| **What it is** | Execution control plane | Policy enforcement system |
| **When it acts** | Pre-execution (gate) | Post-approval (enforcement) |
| **Decision basis** | Contract rules (deterministic) | Policies (often loose) |
| **Failure mode** | Explicit block | Silent failure or race condition |
| **Auditability** | Every decision logged | Often partial/incomplete |
| **Fail mode** | Fail-closed (block if uncertain) | Fail-open (approve if uncertain) |

---

## References

- `scripts/run-clarityburst-phase4-security-tests.ts` - Deterministic arbitration implementation
- `docs/CLARITYBURST_CONTROL_PLANE_ANALOGY.md` - Aircraft/reactor analogies
- `MEMORY.md` - ClarityBurst architecture overview

---

**Status:** ✅ Architecture boundaries defined  
**Next:** Use these terms consistently in all documentation and comments
