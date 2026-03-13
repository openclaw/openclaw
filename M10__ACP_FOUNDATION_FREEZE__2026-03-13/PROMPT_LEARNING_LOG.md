# Mission 10 Prompt Learning Log

## 2026-03-13T00:00:00Z UTC

- Sprint prompt-improvement: add an explicit evidence-scope line for runtime usage checks: `Search repo artifacts first, then only bounded local runtime traces (~/.openclaw, /tmp gateway log, workspace reports) and report hit locations separately from inferred usage.`
- Governance note: a prior prompt-learning entry was misfiled to `ops/missions/mission-003/handover.md`.
- Governance note: correction starts here in Mission 10 local log.
- Governance note: canonical mission path status was previously undefined; `M10__ACP_FOUNDATION_FREEZE__2026-03-13/` is now the working mission path.

## M10-S04

- sprint_id: `M10-S04`
- task: telemetry recent-window dependency check
- prompt pattern used: bounded read-only recent-window runtime search
- result quality: high for local evidence scope; medium for global dependency certainty
- what helped: restricting search to `~/.openclaw/agents/*/sessions/*.jsonl` and extracting inline message timestamps
- what hurt: large historical session artifacts include advisory text mentioning `telemetry.get`, which can overstate live-call evidence without call-type filtering
- change to carry forward: require two timestamps in reports: latest mention and latest confirmed runtime/API call event
- confidence: medium-high
- evidence: historical `telemetry.get` usage found; newest confirmed runtime/API call evidence in active session logs is `2026-02-27T01:10:16.424Z`; no newer matches in the target path
- unknowns: external consumers and non-local runtimes may still call `telemetry.get` outside searched local session history

## M10-S05

- sprint_id: `M10-S05`
- task: telemetry final external-caller check
- prompt pattern used: bounded read-only external-surface verification
- result quality: medium-high for local external surfaces
- what helped: separating session-history evidence from external-facing surfaces (journal/service logs, audit logs, gateway-access-style reports)
- what hurt: many recent files are non-log artifacts; broad file globbing adds noise without extra signal
- change to carry forward: use a two-pass filter by default: `find likely surfaces` then `grep telemetry.get only on those files`
- confidence: medium
- evidence: no `telemetry.get` hits in local external-facing surfaces checked in the last 7 days (journal snippet query, `~/.openclaw/logs/config-audit.jsonl`, and recent workspace report/log artifacts)
- unknowns: external callers from other hosts/services are not observable from this local-only scan

## M10-S06

- sprint_id: `M10-S06`
- task: update issue classification receipt
- prompt pattern used: bounded evidence-to-artifact synthesis
- result quality: high for operational decision support
- what helped: carrying forward explicit VERIFIED/LIKELY/UNKNOWN boundaries from prior steps into one receipt
- what hurt: risk of over-claiming causality when only classification evidence is available
- change to carry forward: always include a single sentence that distinguishes "candidate de-scope" from "globally proven unused"
- confidence: high
- evidence: receipt authored at `M10__ACP_FOUNDATION_FREEZE__2026-03-13/M10_update_issue_receipt.md` with required feature rows and bounded next action
- unknowns: off-host telemetry callers and hidden upstream governor-equivalent paths remain unproven

## M10-S07

- sprint_id: `M10-S07`
- task: minimal reconciliation design note
- prompt pattern used: narrow evidence-backed mapping note
- result quality: high for scope discipline and planning clarity
- what helped: anchoring to the existing update issue receipt as prior source of truth
- what hurt: limited direct evidence on governor insertion points without deeper function-level tracing
- change to carry forward: keep design notes split into `verified primitives`, `partial mapping`, and `unknown insertion points`
- confidence: medium-high
- evidence: authored `M10__ACP_FOUNDATION_FREEZE__2026-03-13/M10_reconciliation_design_note.md` with required sections and explicit partial/unknown mapping boundaries
- unknowns: minimal safe governor insertion points and rollback paths still need focused file/function checklist validation

## M10-S08

- sprint_id: `M10-S08`
- task: bounded insertion-point checklist
- prompt pattern used: narrow repo-inspection-to-checklist
- result quality: high for bounded planning utility; medium-high for insertion-point certainty
- what helped: function-level grep across lane setup/reload, embedded runner enqueue paths, and gateway request-entry handlers
- what hurt: some candidate points are architectural boundaries rather than single function hooks, which limits certainty without path-trace validation
- change to carry forward: require each checklist item to include `primary/fallback/avoid` and a rollback-risk note
- confidence: medium-high
- evidence: authored `M10__ACP_FOUNDATION_FREEZE__2026-03-13/M10_insertion_point_checklist.md` with required structure and candidate surfaces
- unknowns: full request-path coverage for admission controls and whether one boundary hook can safely govern all execution routes

## M10-S09

- sprint_id: `M10-S09`
- task: request-path coverage matrix
- prompt pattern used: bounded path-to-boundary mapping matrix
- result quality: high for boundary clarity; medium for full path-proof certainty
- what helped: combining transport entry checks (`server-http.ts`, WS message handler) with method/endpoint callsite verification to `agentCommand` and lane surfaces
- what hurt: mixed direct and indirect call chains (especially `chat.send` via dispatcher) reduced proof confidence for single-hop tracing
- change to carry forward: require each matrix row to include explicit `gap status` and `conflict note` so inferred coverage never appears as proven
- confidence: medium-high
- evidence: authored `M10__ACP_FOUNDATION_FREEZE__2026-03-13/M10_request_path_coverage_matrix.md` with one admission and one provider-lane insertion point per mapped path
- unknowns: plugin/extension execution routes and `/tools/invoke` provider-lane relevance remain unproven in this bounded pass

## M10-S10

- sprint_id: `M10-S10`
- task: partial path call-chain proof
- prompt pattern used: bounded direct-vs-indirect chain proof
- result quality: high for branch-aware proof clarity; medium-high for runtime completeness
- what helped: explicit branch tracing from entry handler to ACP/non-ACP forks, then to embedded provider-lane enqueue surface
- what hurt: selected provider-lane boundary is branch-dependent, so ACP-ready sessions prevent full direct proof on both target paths
- change to carry forward: require every call-chain proof to include branch map (`ACP path` vs `embedded path`) before assigning COVERED/PARTIAL
- confidence: medium-high
- evidence: authored `M10__ACP_FOUNDATION_FREEZE__2026-03-13/M10_partial_path_call_chain_proof.md` with per-path proof status and unresolved remainder
- unknowns: ACP-equivalent provider-concurrency boundary for these paths is not yet identified

## M10-S11

- sprint_id: `M10-S11`
- task: ACP-side boundary identification
- prompt pattern used: bounded branch-equivalent boundary mapping
- result quality: high for admission/concurrency boundary evidence; medium for provider-equivalence closure
- what helped: tracing both target ACP branches to the shared manager path (`runTurn`) and queue/limit controls
- what hurt: ACP surfaces expose session-level concurrency clearly, but no first-class provider-lane equivalent surface is explicit in inspected code
- change to carry forward: split ACP mapping results into three lanes by default: `admission-equivalent`, `session-concurrency-equivalent`, `provider-equivalent`
- confidence: medium-high
- evidence: authored `M10__ACP_FOUNDATION_FREEZE__2026-03-13/M10_acp_boundary_identification.md` with direct proof of policy/session gates and session-level queue/limit controls, plus explicit provider-equivalence not-proven status
- unknowns: backend-level ACP internals may implement provider/model throttling not visible through current manager/runtime interfaces

## M10-S12

- sprint_id: `M10-S12`
- task: ACP runtime capability probe
- prompt pattern used: bounded capability-equivalence probe
- result quality: high for exposed-control classification; medium-high for backend-internal certainty
- what helped: tracing from runtime type contracts to manager-applied options and concrete `acpx` backend capability advertisement
- what hurt: generic `set_config_option` passthrough allows unknown backend keys, which prevents hard negative proof on hidden provider-throttle options
- change to carry forward: always separate verdict lanes into `direct equivalent`, `partial substitute`, `unrelated`, and `not proven`
- confidence: medium-high
- evidence: authored `M10__ACP_FOUNDATION_FREEZE__2026-03-13/M10_acp_runtime_capability_probe.md` with explicit comparison against non-ACP provider-lane intent
- unknowns: backend-side undocumented model/provider throttling keys may exist outside currently exposed capability metadata

## M10-S13

- sprint_id: `M10-S13`
- task: ACP provider-fairness closure note
- prompt pattern used: bounded closure-note synthesis
- result quality: high for decision clarity and scope discipline
- what helped: reusing prior Mission 10 evidence classifications (admission mapped, session/global concurrency mapped, provider fairness unproven)
- what hurt: avoiding over-interpretation of generic backend config-option passthrough required strict wording discipline
- change to carry forward: closure artifacts should always include an explicit `no implementation action in this mission` decision line
- confidence: high
- evidence: authored `M10__ACP_FOUNDATION_FREEZE__2026-03-13/M10_acp_provider_fairness_closure_note.md` with required branch-equivalence status and mission decision
- unknowns: backend-exposed documented provider/model fairness controls remain unverified for later mission work

## M10-S14

- sprint_id: `M10-S14`
- task: final closeout packaging
- prompt pattern used: bounded closeout synthesis
- result quality: high for manager-facing operational clarity
- what helped: consolidating frozen decisions and deferred questions into one explicit closeout structure with artifact index
- what hurt: balancing concision with full artifact traceability required careful compression
- change to carry forward: kickoff prompts should request an explicit artifact inventory field early to simplify final closeout packaging
- confidence: high
- evidence: authored `M10__ACP_FOUNDATION_FREEZE__2026-03-13/M10_closeout_report.md` and `M10__ACP_FOUNDATION_FREEZE__2026-03-13/M10_prompt_adaptation_receipt.md`
- unknowns: downstream mission policy decision on ACP provider-fairness parity remains open
