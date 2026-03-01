# First-Class Auth Profile Implementation Plan

Status: proposed (execution-ready)
Owner: dev-openclaw
Scope: make provider auth profiles truly first-class, reliable, and trunk-first across CLI/runtime/session UX.

## Why this plan exists

Recent live validation exposed that profile support is functional in parts, but not yet first-class end-to-end:

- `/status` profile-aware usage/source labeling now works.
- Session profile override (`/profile`) works.
- However, profile persistence and storage topology (main vs agent stores) can drift.
- A script-level clobber issue already proved that metadata loss (`order`) is possible.

The goal here is to finish the job so multi-profile behavior is deterministic and trustworthy.

---

## Desired end state (definition of success)

1. **Canonical storage is trunk-first** for profile credentials.
2. **Per-agent data is explicit and narrow** (only agent-specific overrides/telemetry where needed).
3. **One resolver contract** determines effective profile everywhere (chat, CLI, cron, probe, tools).
4. **No silent schema clobbering** from scripts or runtime writes.
5. **UX makes effective profile/source obvious** (override vs inherited vs fallback).
6. **Regression tests cover persistence, precedence, and status parity**.

---

## Explicit design decisions

### 1) Trunk-first auth profile storage

- Canonical credential store: `~/.openclaw/auth-profiles.json`
- Agent-level store remains optional and only for explicit agent-local overrides.
- New profiles created by login/import should land in trunk by default.

### 2) Deterministic effective-profile precedence

Single precedence chain used by all callers:

1. explicit request override (e.g. tool/API payload)
2. session override (`/profile`)
3. agent/provider default profile override
4. provider default profile
5. legacy provider fallback

### 3) Strong write invariants

All mutators must preserve full store shape and avoid top-level key loss.

---

## Workstreams and file touchpoints

## Workstream A — Storage canonicalization (trunk-first)

### A1. Make write scope explicit

**Primary files**

- `src/agents/auth-profiles/paths.ts`
- `src/agents/auth-profiles/store.ts`
- `src/commands/models/auth.ts`
- `src/commands/models/auth-order.ts`

**Changes**

- Introduce explicit store target/scope in write APIs (`global | agent`).
- Default credential writes (`models auth login`, token paste/import) to **global** scope.
- Keep per-agent order overrides explicit and separate.

**Acceptance criteria**

- New profile creation appears in trunk store unless caller explicitly asks for agent scope.
- Existing agent-specific order commands continue to work.

### A2. Clarify read/merge semantics

**Primary files**

- `src/agents/auth-profiles/store.ts`
- `src/agents/auth-profiles/order.ts`

**Changes**

- Document and enforce deterministic merge behavior (trunk baseline + agent overlay).
- Ensure the merge strategy cannot accidentally hide trunk credentials.

**Acceptance criteria**

- Reads from agent context always include trunk credentials unless intentionally shadowed.

---

## Workstream B — Schema-safe mutation and clobber prevention

### B1. Centralize all auth-profile file writes

**Primary files**

- `src/agents/auth-profiles/store.ts`
- `src/agents/auth-profiles/profiles.ts`
- `src/agents/auth-profiles/oauth.ts`
- `src/agents/auth-profiles/usage.ts`
- `scripts/openclaw-codex-profile-sync.sh` (already patched once)

**Changes**

- Ensure every write path uses shared, lock-backed read-modify-write helper.
- Prohibit ad-hoc payload reconstruction that drops keys.

**Acceptance criteria**

- `order`, `lastGood`, `usageStats`, and future top-level keys survive all mutators.

### B2. Add write-invariant tests

**New/updated tests**

- `src/agents/auth-profiles.store.save.test.ts`
- new test file: `src/agents/auth-profiles.store-preserve-top-level.test.ts`
- new test file: `src/agents/auth-profiles.sync-script-preserves-order.test.ts` (or script-level integration test harness)

**Acceptance criteria**

- Tests fail if any mutator drops `order` or other top-level metadata.

---

## Workstream C — Single effective-profile resolver everywhere

### C1. Consolidate resolver contract

**Primary files**

- `src/agents/auth-profiles/session-override.ts`
- `src/agents/model-auth.ts`
- `src/infra/provider-usage.auth.ts`
- `src/commands/models/list.probe.ts`
- `src/cron/isolated-agent/run.ts`

**Changes**

- Introduce/standardize one resolver API that returns:
  - `profileId`
  - `source` (`request|session|agent|provider|legacy`)
  - resolved credential metadata (safe subset)
- Replace duplicated ad-hoc selection logic in callers.

**Acceptance criteria**

- Same input context yields same profile across chat generation, usage probing, cron runs, and model probe tooling.

### C2. Add contract tests across entry points

**Tests**

- precedence tests for all sources
- parity tests across `/status`, execution path, cron isolated run, and probe command

**Acceptance criteria**

- No per-path divergence in effective profile resolution.

---

## Workstream D — Session and command UX clarity

### D1. Make `/profile` report effective source clearly

**Primary files**

- `src/auto-reply/reply/commands-profiles.ts`
- `src/sessions/model-overrides.ts`
- `src/auto-reply/reply/session.ts`

**Changes**

- Extend `/profile` readout to show:
  - explicit override (if present)
  - effective inherited profile and source when override is absent
- Optionally add `/profile effective` alias.

**Acceptance criteria**

- `/profile clear` + `/profile` no longer feels ambiguous.

### D2. `/profiles` improvements

**Primary files**

- `src/auto-reply/reply/commands-profiles.ts`

**Changes**

- Show provider order and next candidate profile.
- Include source labels and cooldown/unavailable reasons.

**Acceptance criteria**

- Users can understand why a specific profile was chosen without reading logs.

---

## Workstream E — `/status` parity and diagnostics

### E1. Keep status profile/source consistent across surfaces

**Primary files**

- `src/auto-reply/reply/commands-status.ts`
- `src/agents/tools/session-status-tool.ts`
- `src/infra/provider-usage.load.ts`
- `src/infra/provider-usage.auth.ts`

**Changes**

- Ensure all status surfaces show usage source profile consistently.
- Add mismatch diagnostic when auth line and usage source diverge.

**Acceptance criteria**

- `/status` and `session_status` agree on auth profile source and usage profile source.

---

## Workstream F — Onboarding/login robustness for profile flows

### F1. Provider login/profile create consistency

**Primary files**

- `src/commands/models/auth.ts`
- provider plugin registration and auth method integration paths

**Changes**

- Harden provider discovery errors for `openai-codex` login.
- Improve profile-id creation/import UX in non-interactive scenarios.
- Keep TTY-required flow explicit, with robust alternatives.

**Acceptance criteria**

- `models auth login --provider openai-codex --profile-id <id>` works consistently where provider is loaded.
- Users have a supported non-interactive import path when TTY is unavailable.

---

## Workstream G — Repair/migration tools for existing installs

### G1. Doctor/repair command

**Primary files**

- `src/agents/auth-profiles/doctor.ts`
- `src/agents/auth-profiles/repair.ts`
- relevant CLI wiring in `src/cli/models-cli.ts` or auth command modules

**Changes**

- Add command to detect and fix:
  - missing `order`
  - trunk/leaf divergence
  - malformed provider order entries
- Add dry-run and backup behavior.

**Acceptance criteria**

- Existing deployments can be repaired safely without manual JSON surgery.

---

## Test matrix (must pass before “first-class” claim)

1. **Persistence safety**
   - write paths preserve `order`, `lastGood`, `usageStats`, unknown keys.
2. **Precedence correctness**
   - request > session > agent > provider > legacy in all entry points.
3. **Session behavior**
   - `/profile clear` + `/profile` clearly reports effective profile and source.
4. **Cross-surface parity**
   - generation path, `/status`, `session_status`, cron, probe agree on profile.
5. **Migration safety**
   - old stores upgrade without destructive behavior.
6. **Runtime parity**
   - local build and installed global runtime produce matching profile behavior.

---

## Execution sequence (recommended)

Phase 1: Storage + write invariants (A + B)

- remove clobber class first

Phase 2: Resolver unification (C)

- guarantee deterministic behavior

Phase 3: UX clarity + status parity (D + E)

- remove ambiguity for users

Phase 4: Onboarding + migration tooling (F + G)

- make it operationally safe and supportable

---

## Definition of done

Profile support is considered first-class only when all are true:

- trunk-first credential lifecycle is enforced by code,
- no known write path can silently drop profile metadata,
- effective-profile resolution is centralized and reused everywhere,
- `/profile`, `/profiles`, `/status`, and `session_status` consistently report source/effective profile,
- migration/repair commands exist for existing installs,
- tests cover persistence + precedence + parity and pass in CI.
