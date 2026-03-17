# PROJECT_MEMORY.md

- Mission Control v2 team model is active: Orbit, Scout, Atlas, Forge, Review, Vault.
- Guardrails are enforced in UI model/state.

## 03/16/2026 Slice Decisions

- Canonical mission config (`mission-control.config.json`) is now consumed through a runtime generated module (`ui/src/ui/mission-control/generated-config.ts`) to reduce drift vs mirrored constants.
- Project-file adapters were added for TASK_QUEUE, PROJECT_MEMORY, PROJECT_INSTRUCTIONS, and TEAM_OPERATING_MODEL via `ui/src/ui/mission-control/adapters.ts`.
- Source class naming was tightened for truthfulness: `indexed-file-content` (freshness-checked) and `preloaded-cache` (non-authoritative) replace ambiguous direct-path wording.
- Seed/live provenance is now explicit in UI using badges: `live`, `mixed`, `seed-backed`, `unavailable`.
- Linkage model added:
  - explicit = source IDs/refs present
  - inferred = derived from stage transition/owner-nextOwner paths
- Guardrail warnings remain advisory in MVP (no hard blocking mutations yet).

## Open Loops

- Replace agent-file-content dependency with direct project-file hydration path where available.
- Expand explicit artifact linkage once stable IDs are available from project/task docs.
- Add dedicated badge styling tokens to improve provenance scannability.
