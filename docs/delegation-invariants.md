# Delegation Invariants (Draft): Confirm / Stop(Takeover) / Receipts

> Status: **Draft for discussion** (docs-only). 
> Goal: define a minimal “thin waist” invariant layer + hook points to keep runtimes **agent-light** as agents shift from assisting to delegated execution.  
> Non-goal: standardize all tools, workflows, UIs, or provider integrations.

## Motivation

As interaction shifts from **Human–App–Cloud** to **Human–Agent–Cloud**, several details that used to be “in-app UX” become **cross-ecosystem invariants**:
- **Confirm**: what authority is granted (scope/limits/TTL), and is it revocable?
- **Stop/Takeover**: where does “stop” stop (step vs chain), and how does takeover work?
- **Receipts**: what record anchors accountability before irreversible commits?

Without a minimal invariant layer, ecosystems tend to either:
1) diverge in semantics across runtimes (higher switching cost / lock-in), or  
2) accumulate ad-hoc policies/adapters inside the runtime (core creep → platform bloat).

## Terminology (minimal)

- **Runtime**: an agent execution environment (e.g., OpenClaw + its plugins/connectors).
- **Tool**: an external capability invoked by the runtime (API, connector, integration).
- **Action**: a discrete step that may cause external side effects.
- **Workflow chain**: a sequence of actions planned/executed on a user’s behalf.
- **Confirm**: an execution-authority event, not a generic UI click.
- **Stop/Takeover**: deterministic halt/override semantics.
- **Receipt**: structured evidence of what happened under which authorization.

## Invariants (thin waist MVP)

This draft proposes **three primitives** and a small set of required fields.
Everything else should be extension-based.

### 1) CONFIRM — Execution Authority Event

**Intent:** Confirm grants bounded execution authority.

**MUST (required):**
- `scope`: what action class / domain is authorized (e.g., “purchase”, “send_message”, “admin_change”)
- `limits`: constraints such as budget caps, max attempts, or allowed targets
- `ttl`: time window for which the authority is valid
- `revocable`: whether this authority can be revoked before commit

**SHOULD (recommended):**
- `risk_level`: low/medium/high (or numeric)

**Example (minimal JSON):**
```json
{
  "type": "confirm",
  "scope": "purchase",
  "limits": { "max_amount_usd": 200, "merchant_allowlist": ["United Airlines"] },
  "ttl_seconds": 900,
  "revocable": true,
  "risk_level": "high"
}
