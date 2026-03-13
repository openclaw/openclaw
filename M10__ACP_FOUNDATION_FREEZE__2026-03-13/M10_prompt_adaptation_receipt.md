# Mission 10 — Prompt Adaptation Receipt

## Top 3 prompt patterns that improved execution

- Bounded, evidence-first scope with explicit “read-only / no code edits” constraints.
- Fixed response schema (`VERIFIED` / `LIKELY` / `UNKNOWN` + one bounded next action), which reduced drift and over-claiming.
- Progressive narrowing sequence (file-level -> line-level -> branch-level -> capability-level), which improved decision quality before freeze decisions.

## Top 3 prompt patterns or instructions that created friction

- Very long command bundles with broad grep patterns increased noise and slowed signal extraction.
- Some path-wide searches produced mixed historical/context artifacts that required extra filtering before claims could be made.
- Repeated format strictness without explicit “reuse prior verified evidence” encouragement caused avoidable re-validation overhead.

## Specific changes recommended for next mission kickoff prompt

- Add an upfront “reuse-verified-evidence-first” rule with a short evidence index to avoid redundant rediscovery.
- Require a two-phase command pattern by default:
  1. discover candidate files/surfaces
  2. run focused proof commands only on those surfaces
- Add a mandatory “branch split” field for every call-chain analysis (`non-ACP` vs `ACP`) at kickoff.
- Add a required “equivalence lane” rubric at kickoff:
  - direct equivalent
  - partial substitute
  - unrelated
  - not proven
- Keep the final response envelope fixed and concise, but allow artifact body depth where evidence density is high.

## Prompt strategy improved over the mission

YES

## Supporting evidence references

- `M10_update_issue_receipt.md`
- `M10_reconciliation_design_note.md`
- `M10_insertion_point_checklist.md`
- `M10_request_path_coverage_matrix.md`
- `M10_partial_path_call_chain_proof.md`
- `M10_acp_boundary_identification.md`
- `M10_acp_runtime_capability_probe.md`
- `M10_acp_provider_fairness_closure_note.md`
- `PROMPT_LEARNING_LOG.md` (M10-S04 through M10-S13)

## Remaining UNKNOWNs

- Backend-exposed documented provider/model fairness controls for ACP remain unverified.
- Operational parity requirement (ACP vs non-ACP provider-fairness behavior) remains a policy decision for later mission scope.
