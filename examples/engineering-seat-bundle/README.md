# Engineering seat bundle

This example freezes the three M11 admission artifacts for a single engineering seat.

- `clean/`: minimal valid lineage, runtime, and policy manifests.
- `known-bad-ui-state/`: a bundle that fails deterministically because runtime truth is sourced from UI state.

The bundle intentionally stays inside M11 scope:

- lineage is canonical and frozen
- runtime truth comes from the runtime manifest
- policy truth comes from the policy manifest
- provenance fields for traces, receipts, route-law, and approvals are preserved
