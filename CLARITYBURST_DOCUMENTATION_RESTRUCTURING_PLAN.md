# ClarityBurst Documentation Restructuring Plan

**Status:** Analysis Complete | Recommendations Ready  
**Date:** 2026-03-07  
**Scope:** Repository-wide inventory and reorganization proposal  
**No Source Code Modified**

---

## Executive Summary

The OpenClaw repository contains **120+ ClarityBurst-related files** spread across 4 main locations:

- **Source Code** (`src/clarityburst/`) – 25+ core modules + 30+ tests
- **Ontology Packs** (`ontology-packs/`) – 13 JSON stage definitions
- **Testing Scripts** (`scripts/`) – 6 ClarityBurst-specific test runners
- **Documentation** (root + `docs/`) – 80+ scattered markdown files + compliance artifacts

**Current Problem:** Documentation is fragmented across root directory and multiple subdirectories, making it difficult to locate, navigate, and maintain a coherent narrative for stakeholders.

**Proposed Solution:** Consolidate all documentation into a clean `clarityburst-docs/` directory with semantic subfolders organized by audience and purpose.

---

## Part 1: Current File Inventory

### 1.1 Source Code Files

**Location:** `src/clarityburst/`

#### Core Modules (12 files)

```
src/clarityburst/
├── config.ts                    # Configuration management (env vars, defaults)
├── stages.ts                    # Stage ID definitions (12 stages)
├── errors.ts                    # ClarityBurstAbstainError type
├── router-client.ts             # HTTP routing logic + allowlist validation
├── pack-registry.ts             # Dynamic ontology pack loading
├── pack-load.ts                 # Pack loading with fail-closed behavior
├── allowed-contracts.ts         # Capability mapping & assertion logic
├── decision-override.ts         # 11 override functions (gating logic)
├── canonicalize.ts              # Action signature normalization
├── cron-dispatch-checker.ts     # Cron task gating
├── cron-task.ts                 # Cron task definition
├── cron-preflight-gate.ts       # Preflight gating for cron
├── decision-cron.ts             # Cron-specific decision logic
├── ledger-verification.ts       # Usage ledger integrity
├── run-metrics.ts               # Metrics collection
└── index.ts                     # Module exports
```

#### Core Tests (4 files)

```
src/clarityburst/
├── config.test.ts               # (implicit from pattern)
├── pack-load.test.ts            # Cross-file integrity, error conversion
├── router-client.duplicate-ids.test.ts  # Duplicate/empty detection
├── stages.packs.test.ts         # Stage ID loadability verification
└── decision-override.test.ts    # Network override + confirmation logic
```

#### Tripwire Tests (30+ files in `__tests__/`)

```
src/clarityburst/__tests__/
├── contract_lookup.not_found.fail_open_only.tripwire.test.ts
├── file_system_ops.ensure_dir.pack_incomplete.fail_closed.tripwire.test.ts
├── file_system_ops.router_outage.fail_closed.tripwire.test.ts
├── file_system_ops.save_session_store.pack_incomplete.fail_closed.at_commit_point.tripwire.test.ts
├── file_system_ops.write_config_file.pack_incomplete.fail_closed.at_commit_point.tripwire.test.ts
├── memory_modify.hook_handler.empty_allowlist.fail_closed.tripwire.test.ts
├── memory_modify.hook_handler.pack_incomplete.fail_closed.tripwire.test.ts
├── memory_modify.hook_handler.router_outage.fail_closed.tripwire.test.ts
├── memory_modify.pack_incomplete.fail_closed.at_commit_point.tripwire.test.ts
├── memory_modify.router_outage.fail_closed.tripwire.test.ts
├── multi_step_autonomy.e2e.test.ts
├── network_io.router_outage.fail_closed.tripwire.test.ts
├── router_outage.fail_closed.production_flag.tripwire.test.ts
├── shell_exec.confirmation.exact_token.tripwire.test.ts
├── subagent_spawn.empty_allowlist.abstain_clarify.tripwire.test.ts
├── subagent_spawn.pack_incomplete.fail_closed.tripwire.test.ts
├── subagent_spawn.router_mismatch.fail_open_only.tripwire.test.ts
├── subagent_spawn.router_outage.fail_closed.tripwire.test.ts
├── threshold_boundary.confidence.exact_match.tripwire.test.ts
├── threshold_boundary.dominance.exact_match.tripwire.test.ts
├── threshold_boundary.missing_top2.fail_safe.tripwire.test.ts
├── tool_dispatch_gate.cron_preflight.lock_required.tripwire.test.ts
├── tool_dispatch_gate.empty_allowlist.abstain_clarify.tripwire.test.ts
├── tool_dispatch_gate.router_mismatch.fail_open_only.tripwire.test.ts
├── tool_dispatch_gate.router_outage.fail_closed.tripwire.test.ts
├── deps.forbid_getPackForStage_imports_from_agents.tripwire.test.ts
└── test-fixtures/
    └── malformed-pack.json
```

---

### 1.2 Ontology Packs

**Location:** `ontology-packs/`

#### Pack JSON Files (13 files)

```
ontology-packs/
├── BROWSER_AUTOMATE.json         # Browser automation stage contracts
├── CANVAS_UI.json                # Canvas UI stage contracts
├── CRON_PREFLIGHT_GATE.json      # Preflight gating stage
├── CRON_SCHEDULE.json            # Cron scheduling stage contracts
├── FILE_SYSTEM_OPS.json          # File system operations stage (127 contracts)
├── MEDIA_GENERATE.json           # Media generation stage contracts
├── MEMORY_MODIFY.json            # Memory modification stage contracts
├── MESSAGE_EMIT.json             # Message emission stage contracts
├── NETWORK_IO.json               # Network I/O stage contracts
├── NODE_INVOKE.json              # Node invocation stage contracts
├── SHELL_EXEC.json               # Shell execution stage contracts
├── SUBAGENT_SPAWN.json           # Subagent spawning stage contracts
└── TOOL_DISPATCH_GATE.json       # Tool dispatch gate stage contracts
```

**Total Contracts:** ~127 across 13 stages

---

### 1.3 Testing & Validation Scripts

**Location:** `scripts/`

```
scripts/
├── clarityburst-verify.ts            # 900-line production readiness harness
│                                       # 7 checks: coverage, dominance (heuristic + strict),
│                                       # agentic loop simulation, outage handling, chaos integration
│
├── run-clarityburst-chaos.ts          # Phase 1-2 chaos runner (sync/async)
├── run-clarityburst-chaos-phase3.ts   # Phase 3 chaos runner (fault injection)
├── run-clarityburst-prompt-injection-test.ts  # Security test runner
├── run-clarityburst-phase4-security-tests.ts  # Phase 4 security tests
│
├── CHAOS_RUNNER_README.md             # Documentation for chaos runner
├── CHAOS_PHASE3_README.md             # Phase 3 documentation
├── CHAOS_PHASES_SUMMARY.md            # Unified phase comparison
├── PROMPT_INJECTION_TEST_GUIDE.md     # Security test documentation
├── PHASE4_SECURITY_TEST_GUIDE.md      # Phase 4 security test guide
├── PHASE4_QUICK_START.md              # Quick reference for Phase 4
├── PHASE4_PRODUCTION_ROADMAP.md       # Production deployment roadmap
├── PHASE3_VALIDATION_MATRIX.md        # Threshold boundary test matrix
│
├── generate-clarityburst-manifest.ts  # Manifest generator
├── verify-usage-ledger-invariants.ts  # Ledger verification
└── analyze-contract-points.ts         # Contract point analyzer
```

---

### 1.4 Documentation Files (Current Locations)

#### Root Directory Documentation (40+ files)

```
/
├── CLARITYBURST_AUDIT_REPORT.md
├── CLARITYBURST_CHAOS_HARDENING.md
├── CLARITYBURST_PRODUCTION_READINESS_REPORT.txt
├── COMPREHENSIVE_VALIDATION_SUMMARY.md
├── INDEX_ALL_DELIVERABLES.md
├── QUICK_REFERENCE_TERMINOLOGY_GUIDE.md
├── REMAINING_ISSUES_PRIORITIZED.md
├── REPOSITORY_DOCUMENTATION_UPDATE_COMPLETE.md
│
├── PHASE_2_ANALYSIS_FILE_SYSTEM_OPS_GATING.md
├── PHASE2_IMPLEMENTATION_COMPLETE.md
├── PHASES_1_2_3_COMPLETE.md
│
├── PHASE3_AUDIT_TRAIL_IMPLEMENTATION.md
├── PHASE3_EXECUTIVE_BRIEF.md
├── PHASE3_VALIDATION_RESULTS_REPORT.md
├── PHASE3_VALIDATION_SCORECARD.md
│
├── PHASE4_COMPLETE_AND_PASSED.md
├── PHASE4_COMPLETE_SUMMARY.md
├── PHASE4_CONFIG_INJECTION_LOGIC_DIFF.md
├── PHASE4_CONFIG_INJECTION_VALIDATION_BLOCK.md
├── PHASE4_ENTERPRISE_SECURITY_SUMMARY_FEATURE.md
├── PHASE4_EXECUTIVE_SUMMARY.md
├── PHASE4_PRIVILEGED_OPS_FUTURE_ROADMAP.md
├── PHASE4_PRIVILEGED_OPS_VALIDATION.md
├── PHASE4_SECURITY_INDEX.md
├── PHASE4_SECURITY_READY_TO_EXECUTE.md
├── PHASE4_STRATEGIC_THREAT_INTELLIGENCE_COMPLETE.md
├── PHASE4_TEST_EXECUTION_RESULTS.md
├── PHASE4_VALIDATION_UPDATE_SUMMARY.md
├── README_PHASE4_COMPLETE.md
│
├── FINAL_DELIVERABLE_SUMMARY.md
├── FINAL_COMPLETION_SUMMARY.md
├── FINAL_CODE_SECTIONS_PRIVILEGED_OPS.md
│
├── FILE_SYSTEM_OPS_DISCOVERY_REPORT.md
├── NETWORK_IO_WIRING_SUMMARY.md
├── NEXT_STEP_DETAILED_ANALYSIS.md
├── TASK_DELIVERABLE_PRIVILEGED_OPS.md
├── TASK_DELIVERABLE_ENTERPRISE_SUMMARY.md
├── TASK_DELIVERABLE_CONFIG_INJECTION_UPDATE.md
├── STATUS_ALL_PHASES_COMPLETE.md
├── SECURITY_VALIDATION_COMPLETE.md
│
├── DOCUMENTATION_UPDATE_VERIFICATION.md
├── THRESHOLD_BOUNDARY_EXPANSION.md
│
└── clarityburst_decision_override_test_after_import_fix.txt
└── clarityburst-only.txt
└── clarityburst-test-output.txt
└── command_new_hits.txt
└── router2_force_test.txt
```

#### `docs/` Directory Documentation (15+ files)

```
docs/
├── clarityburst/
│   ├── VERIFICATION_HARNESS.md           # 1300-line verification documentation
│   ├── PRODUCTION_READINESS_REPORT.md    # Component-by-component readiness
│   ├── IMPLEMENTATION_STATUS.md          # Module status checklist
│   └── NETWORK_IO_WIRING_PLAN.md         # Network I/O integration plan
│
├── CLARITYBURST_ARCHITECTURE_BOUNDARIES.md
├── CLARITYBURST_CONTROL_PLANE_ANALOGY.md      # Control plane design analogies
├── CLARITYBURST_PRODUCTION_READINESS.md
├── CLARITYBURST_PRODUCTION_JOURNEY.md         # Evolution of ClarityBurst design
├── PHASE4_SECURITY_ARCHITECTURE.md
├── PHASE4_CONFIG_INJECTION_VALIDATION_UPDATE.md
├── PHASE3_DOCUMENTATION_STRUCTURE.md
└── PROMPT_INJECTION_SECURITY_SUMMARY.md
```

#### Compliance Artifacts

```
compliance-artifacts/
├── README.md
├── CLARITYBURST_COVERAGE_SUMMARY.md
├── clarityburst-coverage-manifest.json    # Machine-readable: 127 contracts
├── clarityburst-coverage-manifest.yaml    # Human-readable: same data
├── MANIFEST_GENERATION_SUMMARY.txt
├── reachability-ungated-scan-2026-02-06.md
└── security/                              # Test result JSON files (6 files)
    ├── PHASE4_SECURITY_TEST_*.json
    └── ...
```

---

## Part 2: Current Folder Structure Map

```
openclaw/
│
├── src/
│   └── clarityburst/              ← Source code (25+ modules)
│       ├── *.ts                   ← Core modules
│       ├── *.test.ts              ← Unit tests
│       └── __tests__/             ← Tripwire tests (30+ files)
│
├── ontology-packs/                ← Ontology packs (13 JSON files)
│
├── scripts/                        ← Test runners & utilities
│   ├── clarityburst-verify.ts
│   ├── run-clarityburst-*.ts
│   ├── generate-clarityburst-manifest.ts
│   └── *.md                        ← Test documentation (7 files)
│
├── docs/
│   ├── clarityburst/              ← Architecture & readiness (4 files)
│   └── *.md                        ← Various phase docs (10+ files)
│
├── compliance-artifacts/          ← Validation artifacts
│   ├── clarityburst-*.json
│   ├── clarityburst-*.yaml
│   ├── *.md
│   └── security/                  ← Test results
│
└── /                              ← ROOT DIRECTORY (40+ scattered docs)
    └── CLARITYBURST_*.md
    └── PHASE*.md
    └── STATUS_*.md
    └── FINAL_*.md
    └── TASK_*.md
    └── etc.
```

**Current State:** Highly fragmented; difficult to understand documentation hierarchy.

---

## Part 3: Proposed `clarityburst-docs/` Structure

### Directory Tree

```
clarityburst-docs/
│
├── README.md                          # Navigation hub + quick reference
│
├── architecture/                      # Design and system concepts
│   ├── OVERVIEW.md                    # High-level architecture
│   ├── CONTROL_PLANE_ANALOGY.md       # Aircraft/reactor control system analogies
│   ├── ARCHITECTURE_BOUNDARIES.md     # Module boundaries and dominance
│   ├── PRODUCTION_JOURNEY.md          # Evolution of ClarityBurst design
│   └── NETWORK_IO_WIRING_PLAN.md      # Network integration details
│
├── validation/                        # Testing, security, and compliance
│   ├── TESTING_OVERVIEW.md            # Testing strategy summary
│   ├── VERIFICATION_HARNESS.md        # Production readiness harness (1300 LOC)
│   ├── CHAOS_TESTING_GUIDE.md         # Chaos injection methodology
│   │   ├── CHAOS_PHASES_SUMMARY.md    # Phase comparison (1->2->3)
│   │   ├── CHAOS_RUNNER_README.md     # Phase 1-2 runner docs
│   │   └── CHAOS_PHASE3_README.md     # Phase 3 runner docs
│   ├── PROMPT_INJECTION_SECURITY.md   # Security validation
│   │   └── PHASE4_SECURITY_TEST_GUIDE.md
│   ├── SECURITY_AUDIT_REPORT.md       # Audit findings
│   ├── PRODUCTION_READINESS_REPORT.md # Component readiness checklist
│   └── COMPLIANCE_SUMMARY.md          # Validation artifacts summary
│
├── ontology/                          # Ontology pack documentation
│   ├── ONTOLOGY_OVERVIEW.md           # Contracts and stages (127 total)
│   ├── STAGE_DEFINITIONS.md           # 13 stage specifications
│   ├── CONTRACT_REFERENCE.md          # Contract ID lookup
│   └── packs/                         # (Optional: JSON pack documentation)
│       ├── BROWSER_AUTOMATE.md
│       ├── FILE_SYSTEM_OPS.md
│       ├── NETWORK_IO.md
│       ├── SHELL_EXEC.md
│       ├── SUBAGENT_SPAWN.md
│       ├── TOOL_DISPATCH_GATE.md
│       └── ... (7 more)
│
├── security/                          # Security policies and threat analysis
│   ├── SECURITY_OVERVIEW.md           # Security model
│   ├── THREAT_INTELLIGENCE.md         # Strategic threat analysis
│   ├── CONFIGURATION_INJECTION.md     # Config injection validation
│   ├── PRIVILEGE_ESCALATION_HARDENING.md  # Privileged ops security
│   ├── ENTERPRISE_SECURITY_SUMMARY.md # Enterprise threat summary
│   └── HARDENING_ROADMAP.md           # Future security roadmap
│
├── patents/                           # Patent and IP documentation
│   ├── PATENTS_OVERVIEW.md            # Patent references
│   └── LEGAL_FRAMEWORK.md             # Legal and compliance notes
│
├── operations/                        # Operational guides
│   ├── QUICK_START.md                 # 5-minute quick reference
│   ├── OPERATOR_GUIDE.md              # Operations manual
│   ├── PRODUCTION_READINESS_CHECKLIST.md  # Pre-production checklist
│   ├── PRODUCTION_ROADMAP.md          # Deployment roadmap
│   ├── TROUBLESHOOTING.md             # Common issues and fixes
│   ├── RUNBOOKS.md                    # Operational runbooks
│   ├── DEPLOYMENT_CHECKLIST.md        # Deployment steps
│   └── DISASTER_RECOVERY.md           # Recovery procedures
│
├── reference/                         # Quick references and indexes
│   ├── TERMINOLOGY.md                 # Glossary of terms
│   ├── DELIVERABLES_INDEX.md          # All deliverables
│   ├── PHASE_PROGRESSION.md           # Phase 1-2-3-4 evolution
│   ├── IMPLEMENTATION_STATUS.md       # Per-module status
│   └── REMAINING_ISSUES.md            # Prioritized backlog
│
└── compliance/                        # Compliance artifacts
    ├── COVERAGE_SUMMARY.md            # Contract coverage report
    ├── MANIFEST.json                  # Machine-readable manifest
    ├── MANIFEST.yaml                  # Human-readable manifest
    ├── REACHABILITY_SCAN.md           # Ungated scan results
    └── test-results/                  # Test execution artifacts
        └── PHASE4_SECURITY_TEST_*.json
```

---

## Part 4: File Migration Plan

### Phase 1: Create Directory Structure

```
mkdir -p clarityburst-docs/{architecture,validation,ontology,security,patents,operations,reference,compliance/test-results}
```

### Phase 2: Move/Reorganize Documentation

#### Move to `architecture/`

- `docs/CLARITYBURST_CONTROL_PLANE_ANALOGY.md` → `CONTROL_PLANE_ANALOGY.md`
- `docs/CLARITYBURST_ARCHITECTURE_BOUNDARIES.md` → `ARCHITECTURE_BOUNDARIES.md`
- `docs/CLARITYBURST_PRODUCTION_JOURNEY.md` → `PRODUCTION_JOURNEY.md`
- `docs/clarityburst/NETWORK_IO_WIRING_PLAN.md` → `NETWORK_IO_WIRING_PLAN.md`
- Create `OVERVIEW.md` (new: synthesize architecture across all files)

#### Move to `validation/`

- `docs/clarityburst/VERIFICATION_HARNESS.md` → `VERIFICATION_HARNESS.md`
- `scripts/CHAOS_PHASES_SUMMARY.md` → `CHAOS_TESTING_GUIDE.md` (master doc)
- `scripts/CHAOS_RUNNER_README.md` → `CHAOS_TESTING_GUIDE/CHAOS_RUNNER_README.md`
- `scripts/CHAOS_PHASE3_README.md` → `CHAOS_TESTING_GUIDE/CHAOS_PHASE3_README.md`
- `docs/PROMPT_INJECTION_SECURITY_SUMMARY.md` → `PROMPT_INJECTION_SECURITY.md`
- `scripts/PROMPT_INJECTION_TEST_GUIDE.md` → `PROMPT_INJECTION_SECURITY/PROMPT_INJECTION_TEST_GUIDE.md`
- `root/CLARITYBURST_AUDIT_REPORT.md` → `SECURITY_AUDIT_REPORT.md`
- `root/CLARITYBURST_CHAOS_HARDENING.md` → `(merge into CHAOS_TESTING_GUIDE)`
- `root/COMPREHENSIVE_VALIDATION_SUMMARY.md` → `COMPLIANCE_SUMMARY.md`
- `docs/clarityburst/PRODUCTION_READINESS_REPORT.md` → `PRODUCTION_READINESS_REPORT.md`
- Create `TESTING_OVERVIEW.md` (new: master testing strategy)

#### Move to `security/`

- `root/PHASE4_STRATEGIC_THREAT_INTELLIGENCE_COMPLETE.md` → `THREAT_INTELLIGENCE.md`
- `root/PHASE4_CONFIG_INJECTION_LOGIC_DIFF.md` → `CONFIGURATION_INJECTION.md` (merge)
- `root/PHASE4_CONFIG_INJECTION_VALIDATION_BLOCK.md` → `CONFIGURATION_INJECTION.md` (merge)
- `docs/PHASE4_CONFIG_INJECTION_VALIDATION_UPDATE.md` → `CONFIGURATION_INJECTION.md` (merge)
- `root/PHASE4_ENTERPRISE_SECURITY_SUMMARY_FEATURE.md` → `ENTERPRISE_SECURITY_SUMMARY.md`
- `root/PHASE4_PRIVILEGED_OPS_VALIDATION.md` → `PRIVILEGE_ESCALATION_HARDENING.md` (merge)
- `root/PHASE4_PRIVILEGED_OPS_FUTURE_ROADMAP.md` → `HARDENING_ROADMAP.md`
- `root/TASK_DELIVERABLE_CONFIG_INJECTION_UPDATE.md` → (merge into CONFIGURATION_INJECTION)
- `root/TASK_DELIVERABLE_ENTERPRISE_SUMMARY.md` → (merge into ENTERPRISE_SECURITY_SUMMARY)
- `root/SECURITY_VALIDATION_COMPLETE.md` → (merge into TESTING_OVERVIEW)
- Create `SECURITY_OVERVIEW.md` (new: security model synthesis)

#### Move to `ontology/`

- `compliance-artifacts/CLARITYBURST_COVERAGE_SUMMARY.md` → `COVERAGE_SUMMARY.md`
- Create `ONTOLOGY_OVERVIEW.md` (new: explanation of 127 contracts)
- Create `STAGE_DEFINITIONS.md` (new: document 13 stages)
- Create `CONTRACT_REFERENCE.md` (new: lookup guide)
- Create `packs/` subdirectory with individual pack documentation

#### Move to `patents/`

- (Any patent-related documentation; create if not present)
- Create `PATENTS_OVERVIEW.md` (new: IP framework)

#### Move to `operations/`

- `scripts/PHASE4_QUICK_START.md` → `QUICK_START.md`
- `scripts/PHASE4_PRODUCTION_ROADMAP.md` → `PRODUCTION_ROADMAP.md`
- Create `OPERATOR_GUIDE.md` (new: ops manual)
- Create `PRODUCTION_READINESS_CHECKLIST.md` (new: pre-prod checklist)
- Create `TROUBLESHOOTING.md` (new: FAQ)
- Create `RUNBOOKS.md` (new: operational runbooks)
- Create `DEPLOYMENT_CHECKLIST.md` (new: deployment steps)
- Create `DISASTER_RECOVERY.md` (new: recovery procedures)

#### Move to `reference/`

- `root/QUICK_REFERENCE_TERMINOLOGY_GUIDE.md` → `TERMINOLOGY.md`
- `root/INDEX_ALL_DELIVERABLES.md` → `DELIVERABLES_INDEX.md`
- Create `PHASE_PROGRESSION.md` (new: Phase 1→2→3→4 evolution)
- `docs/clarityburst/IMPLEMENTATION_STATUS.md` → `IMPLEMENTATION_STATUS.md`
- `root/REMAINING_ISSUES_PRIORITIZED.md` → `REMAINING_ISSUES.md`

#### Move to `compliance/`

- `compliance-artifacts/clarityburst-coverage-manifest.json` → `MANIFEST.json`
- `compliance-artifacts/clarityburst-coverage-manifest.yaml` → `MANIFEST.yaml`
- `compliance-artifacts/reachability-ungated-scan-2026-02-06.md` → `REACHABILITY_SCAN.md`
- Move test results from `compliance-artifacts/security/` → `test-results/`
- Create `COVERAGE_SUMMARY.md` (merged from `compliance-artifacts/CLARITYBURST_COVERAGE_SUMMARY.md`)

#### Archive/Remove (Phase-specific summaries)

```
root/PHASE2_IMPLEMENTATION_COMPLETE.md        → archive/
root/PHASE3_AUDIT_TRAIL_IMPLEMENTATION.md     → archive/
root/PHASE3_EXECUTIVE_BRIEF.md                → archive/
root/PHASE3_VALIDATION_RESULTS_REPORT.md      → archive/
root/PHASE3_VALIDATION_SCORECARD.md           → archive/
root/PHASE4_COMPLETE_AND_PASSED.md            → archive/
root/PHASE4_COMPLETE_SUMMARY.md               → archive/
root/PHASE4_EXECUTIVE_SUMMARY.md              → archive/
root/PHASE4_SECURITY_INDEX.md                 → archive/
root/PHASE4_SECURITY_READY_TO_EXECUTE.md      → archive/
root/PHASE4_TEST_EXECUTION_RESULTS.md         → archive/
root/PHASE4_VALIDATION_UPDATE_SUMMARY.md      → archive/
root/PHASE_2_ANALYSIS_FILE_SYSTEM_OPS_GATING.md → archive/
root/PHASES_1_2_3_COMPLETE.md                 → archive/
root/README_PHASE4_COMPLETE.md                → archive/
root/FINAL_*.md                               → archive/
root/STATUS_ALL_PHASES_COMPLETE.md            → archive/
root/TASK_DELIVERABLE_*.md (except merged)    → archive/
root/FILE_SYSTEM_OPS_DISCOVERY_REPORT.md      → archive/
root/NEXT_STEP_DETAILED_ANALYSIS.md           → archive/
root/NETWORK_IO_WIRING_SUMMARY.md             → archive/
root/THRESHOLD_BOUNDARY_EXPANSION.md          → archive/
root/DOCUMENTATION_UPDATE_VERIFICATION.md     → archive/
root/REPOSITORY_DOCUMENTATION_UPDATE_COMPLETE.md → archive/
root/*.txt (test output logs)                 → archive/
```

### Phase 3: Create Navigation Hub (`clarityburst-docs/README.md`)

Structure:

```markdown
# ClarityBurst Documentation Hub

Quick links by audience:
- **For Operators:** [Quick Start](operations/QUICK_START.md), [Operator Guide](operations/OPERATOR_GUIDE.md)
- **For Architects:** [Architecture Overview](architecture/OVERVIEW.md), [Design Patterns](architecture/CONTROL_PLANE_ANALOGY.md)
- **For Security Teams:** [Security Audit](security/SECURITY_AUDIT_REPORT.md), [Threat Intelligence](security/THREAT_INTELLIGENCE.md)
- **For Compliance:** [Coverage Summary](compliance/COVERAGE_SUMMARY.md), [Manifest](compliance/MANIFEST.json)

Directory Structure:
- `architecture/` – Design, boundaries, wiring plans
- `validation/` – Testing, chaos injection, security
- `ontology/` – Contracts, stages, pack definitions
- `security/` – Security analysis, threat intel, hardening
- `patents/` – IP and legal framework
- `operations/` – Operator guides, runbooks, checklists
- `reference/` – Terminology, indexes, status
- `compliance/` – Validation artifacts, manifests

See [File Map](#file-mapping) for complete inventory.
```

---

## Part 5: Recommended Action Items

### Immediate (Day 1)

- [ ] Create `clarityburst-docs/` directory structure
- [ ] Move architecture documentation
- [ ] Create navigation README

### Short-term (Week 1)

- [ ] Move all validation documentation
- [ ] Move security documentation
- [ ] Move ontology documentation
- [ ] Move operations guides

### Medium-term (Week 2)

- [ ] Move reference documentation
- [ ] Archive phase-specific documents
- [ ] Create merged/synthesized documents

### Ongoing

- [ ] Update all cross-repo links to point to new locations
- [ ] Update CONTRIBUTING.md with new doc locations
- [ ] Add `clarityburst-docs/` section to main README

---

## Part 6: Benefits of Proposed Structure

| Aspect | Current | Proposed |
|--------|---------|----------|
| **Discovery** | Scattered; 40+ root files | Organized by purpose; 8 main folders |
| **Navigation** | No clear hierarchy | Semantic grouping; README hub |
| **Audience-Driven** | Mixed docs for all audiences | Separate paths for operators/architects/security |
| **Artifact Organization** | `compliance-artifacts/` separate | Consolidated in `compliance/` subfolder |
| **Script Docs** | In `scripts/` directory | In `validation/` with test runners referenced |
| **Maintenance** | Hard to track related docs | Clear relationships; easier to update |
| **Onboarding** | No central entry point | README hub provides landing page |

---

## Part 7: Cross-Reference Map

### Files Sourced from Root

**Move Count:** 40+ files  
**Consolidation:** 15-20 merged documents  
**Net Result:** 120+ scattered files → 60+ organized files

### Files Sourced from `docs/`

**Move Count:** 15+ files  
**Consolidation:** Merged into parent folders  
**Net Result:** Flatter hierarchy

### Files Sourced from `scripts/`

**Move Count:** 7 markdown files  
**Note:** Keep test runner .ts files in `scripts/`; move docs to `clarityburst-docs/`

### Files Sourced from `compliance-artifacts/`

**Move Count:** 6 files + subdirectory  
**Note:** Keep `.json` manifest auto-generated; reorganize in `compliance/`

---

## Summary Table: File Movement

| Current Location | New Location | File Count | Notes |
|---|---|---|---|
| `root/` | `clarityburst-docs/` | 40+ | Scatter consolidated; 15-20 merged |
| `docs/clarityburst/` | `clarityburst-docs/` | 4 | Moved and reorganized |
| `docs/` (CLARITYBURST_*) | `clarityburst-docs/` | 10+ | Distributed by purpose |
| `scripts/` (*.md) | `clarityburst-docs/validation/` | 7 | Test docs only; runners stay in `scripts/` |
| `compliance-artifacts/` | `clarityburst-docs/compliance/` | 6 | Artifacts consolidated |
| `ontology-packs/` | Reference from `clarityburst-docs/ontology/` | 13 | JSON files stay in place; docs reference them |

---

## File Count Summary

```
BEFORE:
  Root directory:            40+ scattered files
  docs/:                     15+ files (some in subdirectories)
  scripts/:                  7 markdown files (mixed with code)
  compliance-artifacts/:     6+ files
  ──────────────────────────
  TOTAL:                     ~80 fragmented files

AFTER:
  clarityburst-docs/:        ~60 organized files
  Remaining references:      Symlinks or references from other docs
  ──────────────────────────
  TOTAL:                     Consolidated, semantic hierarchy
```

---

## No Source Code Changes Required

✅ This proposal preserves all:

- `src/clarityburst/*.ts` – Core modules untouched
- `ontology-packs/*.json` – Ontology packs untouched
- `scripts/*.ts` – Test runners untouched
- `src/clarityburst/__tests__/*.test.ts` – Test code untouched

**Only Documentation Files Are Reorganized**

---

## Next Steps

1. **Approve Structure** – Review proposed hierarchy
2. **Create Directories** – Implement `clarityburst-docs/` structure
3. **Migrate Files** – Move and merge documentation
4. **Update Cross-Links** – Fix broken references
5. **Archive Old Docs** – Move phase summaries to `clarityburst-docs/archive/`
6. **Create Hub** – Write `clarityburst-docs/README.md`
7. **Update Meta** – Point CONTRIBUTING.md to new location

---

## Appendix: Complete File Inventory by Proposed Destination

### `clarityburst-docs/architecture/`

```
OVERVIEW.md                           (NEW: synthesized)
CONTROL_PLANE_ANALOGY.md              (from docs/)
ARCHITECTURE_BOUNDARIES.md            (from docs/)
PRODUCTION_JOURNEY.md                 (from docs/)
NETWORK_IO_WIRING_PLAN.md             (from docs/clarityburst/)
```

### `clarityburst-docs/validation/`

```
TESTING_OVERVIEW.md                   (NEW: synthesized)
VERIFICATION_HARNESS.md               (from docs/clarityburst/)
CHAOS_TESTING_GUIDE.md                (from scripts/)
  ├── CHAOS_RUNNER_README.md          (from scripts/)
  └── CHAOS_PHASE3_README.md          (from scripts/)
PROMPT_INJECTION_SECURITY.md          (from docs/)
  └── PROMPT_INJECTION_TEST_GUIDE.md  (from scripts/)
SECURITY_AUDIT_REPORT.md              (from root/)
CLARITYBURST_CHAOS_HARDENING.md       (from root/)
PRODUCTION_READINESS_REPORT.md        (from docs/clarityburst/)
COMPLIANCE_SUMMARY.md                 (from root/)
```

### `clarityburst-docs/ontology/`

```
ONTOLOGY_OVERVIEW.md                  (NEW: synthesized)
STAGE_DEFINITIONS.md                  (NEW: synthesized)
CONTRACT_REFERENCE.md                 (NEW: lookup guide)
COVERAGE_SUMMARY.md                   (from compliance-artifacts/)
packs/
  ├── BROWSER_AUTOMATE.md             (NEW: pack explanation)
  ├── CANVAS_UI.md
  ├── CRON_PREFLIGHT_GATE.md
  ├── CRON_SCHEDULE.md
  ├── FILE_SYSTEM_OPS.md
  ├── MEDIA_GENERATE.md
  ├── MEMORY_MODIFY.md
  ├── MESSAGE_EMIT.md
  ├── NETWORK_IO.md
  ├── NODE_INVOKE.md
  ├── SHELL_EXEC.md
  ├── SUBAGENT_SPAWN.md
  └── TOOL_DISPATCH_GATE.md
```

### `clarityburst-docs/security/`

```
SECURITY_OVERVIEW.md                  (NEW: synthesized)
THREAT_INTELLIGENCE.md                (from root/)
CONFIGURATION_INJECTION.md            (from root/ + docs/)
ENTERPRISE_SECURITY_SUMMARY.md        (from root/)
PRIVILEGE_ESCALATION_HARDENING.md     (from root/)
HARDENING_ROADMAP.md                  (from root/)
```

### `clarityburst-docs/operations/`

```
QUICK_START.md                        (from scripts/)
OPERATOR_GUIDE.md                     (NEW: synthesized)
PRODUCTION_READINESS_CHECKLIST.md     (NEW: pre-prod)
PRODUCTION_ROADMAP.md                 (from scripts/)
TROUBLESHOOTING.md                    (NEW: FAQ)
RUNBOOKS.md                           (NEW: operational)
DEPLOYMENT_CHECKLIST.md               (NEW: deployment)
DISASTER_RECOVERY.md                  (NEW: recovery)
```

### `clarityburst-docs/reference/`

```
TERMINOLOGY.md                        (from root/)
DELIVERABLES_INDEX.md                 (from root/)
PHASE_PROGRESSION.md                  (NEW: evolution)
IMPLEMENTATION_STATUS.md              (from docs/clarityburst/)
REMAINING_ISSUES.md                   (from root/)
```

### `clarityburst-docs/compliance/`

```
COVERAGE_SUMMARY.md                   (from compliance-artifacts/)
MANIFEST.json                         (from compliance-artifacts/)
MANIFEST.yaml                         (from compliance-artifacts/)
REACHABILITY_SCAN.md                  (from compliance-artifacts/)
test-results/
  └── PHASE4_SECURITY_TEST_*.json     (from compliance-artifacts/security/)
```

### `clarityburst-docs/archive/`

```
(Phase-specific summaries)
PHASE2_IMPLEMENTATION_COMPLETE.md
PHASE3_AUDIT_TRAIL_IMPLEMENTATION.md
PHASE3_EXECUTIVE_BRIEF.md
PHASE3_VALIDATION_RESULTS_REPORT.md
PHASE3_VALIDATION_SCORECARD.md
PHASE4_COMPLETE_AND_PASSED.md
PHASE4_COMPLETE_SUMMARY.md
PHASE4_EXECUTIVE_SUMMARY.md
PHASE4_SECURITY_INDEX.md
PHASE4_SECURITY_READY_TO_EXECUTE.md
PHASE4_TEST_EXECUTION_RESULTS.md
PHASE4_VALIDATION_UPDATE_SUMMARY.md
PHASE_2_ANALYSIS_FILE_SYSTEM_OPS_GATING.md
PHASES_1_2_3_COMPLETE.md
README_PHASE4_COMPLETE.md
FINAL_*.md
STATUS_ALL_PHASES_COMPLETE.md
TASK_DELIVERABLE_*.md (non-merged)
FILE_SYSTEM_OPS_DISCOVERY_REPORT.md
NEXT_STEP_DETAILED_ANALYSIS.md
NETWORK_IO_WIRING_SUMMARY.md
THRESHOLD_BOUNDARY_EXPANSION.md
DOCUMENTATION_UPDATE_VERIFICATION.md
REPOSITORY_DOCUMENTATION_UPDATE_COMPLETE.md
```

---

**End of Analysis Document**  
**No source code modifications made**  
**Documentation structure proposal only**
