AGENTS.md

---

## Local Development Workflow

### Managing Local Changes with GitHub Updates

Since OpenClaw is regularly updated from GitHub, we use a separate `local/custom-features` branch to keep your local customizations safe from being overwritten.

**Quick Start:**
```bash
# Update from GitHub while preserving local changes
./scripts/update-local-changes.sh
```

**Manual Steps (if needed):**
```bash
# 1. Fetch latest from GitHub
git fetch origin

# 2. Update main
git checkout main
git reset --hard origin/main

# 3. Rebase your changes on top
git checkout local/custom-features
git rebase main
```

**If conflicts occur:**
```bash
# Fix conflicts in your editor, then:
git add .
git rebase --continue

# Or abort if needed:
git rebase --abort
```

**Branch Strategy:**
- `main` - Always matches GitHub (safe to reset)
- `local/custom-features` - Your local customizations (never force-reset)

---

## FrankOS Governance Runtime

When operating in FrankOS mode, use runtime governance controls in addition to document guidance.

- Load runtime policy artifact: `10_Constitution/GOVERNANCE_RUNTIME_POLICY.json`
- Governance decision hierarchy: Mission > Constitution > Safety > Working Principles > Project Context > Task Instructions
- Enforcement modes:
  - `off`: no runtime governance checks
  - `shadow`: evaluate and log decisions, do not block
  - `enforce`: block `prohibit` and `escalate` outcomes

For tool-level guardrails, use the `frankos-governance` plugin and emit `governance.decision` diagnostics for auditability.

### Memory Integrity Runtime (Phase 3)

- Load memory policy artifact: `10_Constitution/MEMORY_RUNTIME_POLICY.json`
- Validate policy shape against: `14_Schemas/memory-runtime-policy.schema.json`
- Use `frankos-memory-governance` plugin for memory write guardrails:
  - `shadow`: evaluate and emit memory governance telemetry, allow writes
  - `enforce`: block `prohibit` and `escalate` outcomes (fail closed on policy load/eval errors)
- Memory telemetry events:
  - `memory.governance.decision`
  - `memory.provenance.validation_failure`
  - `memory.correction.supersession`

### Rollout Ops Quick Checks (Phase 4)

- Stage progression:
  - `dev-shadow`: all governance plugins in `shadow`; verify stable telemetry coverage.
  - `canary-enforce`: limited traffic in `enforce`; verify block/escalate reason-code stability.
  - `prod-enforce`: full rollout only after canary evidence and rollback readiness are approved.
- Fast operator checks:
  - mode check: confirm expected rollout mode in runtime/config and recent diagnostics events
  - telemetry sanity: confirm `governance.decision` and memory governance events are present with session/run ids
  - policy health: validate policy/schema files are readable and parse cleanly
- Rollback triggers:
  - sudden block-rate spike without policy change
  - diagnostics/OTEL pipeline failure during enforce
  - sustained escalation drift beyond expected baseline
- Rollback action:
  - switch mode to `shadow`, keep telemetry on, capture incident evidence, and review before re-promoting.
