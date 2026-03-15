---
summary: "Deterministic M11 admission rules for lineage, runtime, and policy bundles"
read_when:
  - Implementing or reviewing lineage admission in M11
  - Deciding whether a Design Studio bundle is admissible
  - Verifying deterministic reject conditions for registry publication
title: "Lineage Admission Rules"
---

# Lineage admission rules

Last updated: 2026-03-15

Mission M11 accepts a bundle only when all three frozen manifests are present,
schema-valid, and mutually consistent.

## Admission inputs

The only admission inputs are:

- `agent.lineage.json`
- `agent.runtime.json`
- `agent.policy.json`

Matching schemas:

- `schemas/agent.lineage.schema.json`
- `schemas/agent.runtime.schema.json`
- `schemas/agent.policy.schema.json`

Admission must not read UI state as a substitute for any missing manifest field.

## Accept conditions

Accept the bundle only when all of the following are true:

- all three manifests exist
- each manifest validates against its schema
- the lineage record is canonical
- runtime truth source is `manifest`
- all three manifests bind to the same lineage id and lineage digest
- runtime and policy manifests bind to the same registry namespace and record key
- provenance fields are present for Design Studio output and manifest authorship
- trace, receipt, route-law, and approval namespaces are present

## Deterministic reject conditions

Reject the bundle if any of the following occur:

- a required manifest is missing
- a manifest contains an unknown top-level field
- a required provenance field is missing
- `agent.lineage.json` is not canonical
- `agent.runtime.json` uses any runtime truth source other than `manifest`
- any manifest attempts to encode runtime truth only through UI state
- lineage ids or lineage digests disagree across manifests
- registry namespace or record key disagree across runtime and policy manifests
- approval namespace is missing

The reject result should be deterministic: the same invalid bundle should always
fail for the same concrete reason until the bundle changes.

## Recommended validation order

Use a stable order so receipts stay reproducible:

1. Check manifest existence.
2. Validate each manifest against its schema.
3. Confirm lineage identity and digest agreement.
4. Confirm registry namespace and record key agreement.
5. Confirm provenance and namespace coverage.
6. Reject any bundle that still depends on UI state as runtime truth.

## M11 boundary

These rules stop at admission.

They do not define:

- route-law decisions after admission
- bus transport behavior
- runtime process boundaries
- edge distribution or publication

Those concerns belong to later missions. M11 only freezes the admissible bundle
contract and the reject rules around it.

## Example bundles

- Valid: `examples/engineering-seat-bundle/clean/`
- Invalid: `examples/engineering-seat-bundle/known-bad-ui-state/`

## Related docs

- [Design Studio Output Contracts](/architecture/design-studio-output-contracts)
