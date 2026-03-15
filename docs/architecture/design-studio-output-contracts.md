---
summary: "Frozen M11 contract for Design Studio outputs, registry admission inputs, and example bundle layout"
read_when:
  - Defining or reviewing the M11 Design Studio output contract
  - Publishing a lineage, runtime, and policy bundle to the registry
  - Checking what M11 does and does not freeze
title: "Design Studio Output Contracts"
---

# Design Studio output contracts

Last updated: 2026-03-15

Mission M11 freezes the three Design Studio outputs that admission and registry
flows are allowed to trust:

- `schemas/agent.lineage.schema.json`
- `schemas/agent.runtime.schema.json`
- `schemas/agent.policy.schema.json`

Anything outside those manifests is non-canonical for M11.

## Canonical bundle

A minimal bundle is a directory with these artifacts:

- `agent.lineage.json`
- `agent.runtime.json`
- `agent.policy.json`

Example: `examples/engineering-seat-bundle/clean/`

Each file is validated independently against its matching schema. Admission then
checks that the files agree on lineage identity, provenance digests, registry
namespace, and approval namespace.

## Frozen responsibilities

### Lineage record

The lineage record is the canonical identity document.

It freezes:

- lineage id
- agent id
- seat identity and namespace
- Design Studio output digest
- provenance inputs
- trace and receipt namespaces

For M11, the lineage record must be canonical and immutable. Later missions may
consume these fields, but M11 only freezes them.

### Runtime manifest

The runtime manifest is the canonical runtime truth.

It freezes:

- runtime id
- lineage binding
- registry namespace and record key
- runtime executor, provider, and model
- instructions and tool catalog digests
- provenance and receipt digests

UI state is not runtime truth. Design tools can render drafts, previews, and
temporary selections, but admission must ignore them unless they are represented
in the runtime manifest.

### Policy manifest

The policy manifest is the canonical admission and approval truth.

It freezes:

- lineage binding
- registry namespace and record key
- required admission artifacts
- deterministic reject switches
- approval mode and required approval scopes
- provenance and receipt digests

## Design Studio to registry contract

M11 freezes a narrow handoff:

1. Design Studio emits exactly one lineage record, one runtime manifest, and one
   policy manifest for a seat bundle.
2. Registry or admission code reads only those frozen manifests.
3. Registry or admission code rejects missing provenance, mismatched lineage
   digests, non-canonical lineage, and UI-state-only truth.
4. Registry storage keys come from the frozen manifests, not from presentation
   labels or in-memory editor state.

This keeps the contract deterministic without pulling in M12 route law, M13 bus
mechanics, M14 boundary refactors, or M15 edge publication concerns.

## Provenance fields preserved in M11

The schemas preserve the fields later missions will need for traces, receipts,
route-law binding, and approvals:

- `trace.traceNamespace`
- `trace.receiptNamespace`
- `trace.routeLawNamespace`
- `trace.approvalNamespace`
- provenance digests tied to Design Studio output
- manifest receipt digests

M11 preserves these fields as frozen inputs. It does not define the downstream
execution semantics yet.

## Out of scope

M11 does not define:

- route law execution order
- event bus behavior
- runtime boundary refactors
- edge publication or replication
- UI state persistence rules beyond "UI state is not runtime truth"

## Related docs

- [Lineage Admission Rules](/architecture/lineage-admission-rules)
