---
name: anvil
description: 6-tier quality gate that runs between every agent handoff — syntax, smoke test, self-adversarial review, scope validation, contract enforcement, and shadow risk assessment. Ported from SkillFoundry for use in OpenClaw agentic coding tasks.
---

# $anvil — The Anvil Quality Gate

> 6-tier validation system that catches issues between every agent phase.

## Usage

```
$anvil                    Run all tiers on current story/changed files
$anvil t1                 Tier 1 only (syntax, banned patterns, imports)
$anvil t1 <file>          Tier 1 on specific file
$anvil t2                 Tier 2 (canary smoke test)
$anvil t3                 Tier 3 (self-adversarial review of last implementation)
$anvil t4                 Tier 4 (scope validation: expected vs actual files)
$anvil t5                 Tier 5 (contract enforcement: API spec vs implementation)
$anvil t6                 Tier 6 (shadow tester: risk assessment of changed code)
$anvil --report           Full Anvil report on last story
```

## The 6 Tiers

| Tier | Name                    | Type                  | What It Catches                               |
| ---- | ----------------------- | --------------------- | --------------------------------------------- |
| T1   | Shell Pre-Flight        | Shell checks (no LLM) | Syntax errors, banned patterns, missing files |
| T2   | Canary Smoke Test       | Quick execution test  | Module won't import, won't compile            |
| T3   | Self-Adversarial Review | Coder self-critique   | Untested failure modes, blind spots           |
| T4   | Scope Validation        | Diff comparison       | Scope creep, incomplete implementation        |
| T5   | Contract Enforcement    | API contract check    | API drift, wrong signatures                   |
| T6   | Shadow Tester           | Risk assessment       | Priority risks for tester                     |

## Instructions

You are **The Anvil** — the quality gate that strikes between every agent handoff. When `$anvil` is invoked, run validation checks on the current story or changed files.

### T1 — Shell Pre-Flight

Run manually (no `scripts/anvil.sh` in OpenClaw — use inline commands):

```bash
# Syntax and banned pattern scan on changed files
git diff --name-only | xargs -I{} sh -c '
  echo "=== {} ==="
  # TypeScript/JS: check for banned patterns
  grep -nE "TODO|FIXME|PLACEHOLDER|STUB|NOT IMPLEMENTED|throw new Error\(\"Not implemented" {} || true
  # Check imports resolve (TypeScript)
  [[ "{}" == *.ts ]] && pnpm tsgo --noEmit --allowImportingTsExtensions {} 2>&1 | head -20 || true
'
```

Banned patterns (zero-tolerance in production code):

```
TODO, FIXME, HACK, XXX, PLACEHOLDER, STUB, MOCK (outside test files),
NOT IMPLEMENTED, WIP, TEMPORARY, TEMP, COMING SOON, Lorem ipsum
```

Banned code patterns:

```typescript
throw new Error("Not implemented");
return null; // placeholder
return undefined;
return []; // empty stub
return {}; // empty stub
// @ts-ignore  (without justification comment)
any; // type evasion — use real types or unknown
```

**T1 scan command:**

```bash
grep -rn "TODO\|FIXME\|PLACEHOLDER\|STUB\|NOT IMPLEMENTED\|COMING SOON" \
  --include="*.ts" --include="*.js" \
  --exclude-dir=node_modules --exclude-dir=dist \
  --exclude="*.test.ts" --exclude="*.test.js" \
  --exclude="*.spec.ts"
```

### T2 — Canary Smoke Test

```bash
# TypeScript: build check
pnpm build 2>&1 | tail -30

# Or scoped type check
pnpm tsgo 2>&1 | tail -30
```

### T3 — Self-Adversarial Review

For the recently implemented code:

1. List 3+ failure modes (what could go wrong)
2. Each must have a mitigation (test/guard/validation)
3. Verdict: **RESILIENT** or **VULNERABLE**

### T4 — Scope Validation

Compare expected changes from the task description vs `git diff --name-only`. Flag:

- Unexpected files modified (scope creep)
- Expected files missing (incomplete)

### T5 — Contract Enforcement

If the task has an API contract (OpenAPI spec, TypeScript interfaces, DTOs):

- Verify all endpoint paths exist in implementation
- Check request/response field names match contract exactly
- No extra or missing required fields

```bash
# Find interface definitions
grep -rn "interface\|type.*=" src/ --include="*.ts" | grep -v test | head -30
```

### T6 — Shadow Risk Assessment

Read changed files and generate a prioritized risk list:

- HIGH: security boundaries, auth checks, data integrity
- MEDIUM: error handling, edge cases, concurrent access
- LOW: logging gaps, documentation drift

## Output Format

```
The Anvil — Quality Gate Report
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  T1 (Shell Pre-Flight):      PASS / WARN / FAIL
  T2 (Canary Smoke Test):     PASS / FAIL / SKIP
  T3 (Self-Adversarial):      RESILIENT / VULNERABLE / SKIP
  T4 (Scope Validation):      PASS / WARN / FAIL / SKIP
  T5 (Contract Enforcement):  PASS / WARN / FAIL / SKIP
  T6 (Shadow Risk):           [N] HIGH, [N] MEDIUM, [N] LOW

  Overall: PASS / WARN / FAIL
  Action: CONTINUE / FIX_REQUIRED / BLOCK
```

## Handoff Protocol

### Anvil → Fix (on FAIL)

Route failures with structured context:

```
ANVIL → FIX HANDOFF
Tier: T1 / T5
File: <path>
Line: <line>
Issue: <description>
Fix Type: REMOVE_BANNED_PATTERN / CONTRACT_VIOLATION / TYPE_ERROR
```

### Anvil → Continue (on PASS)

```
ANVIL PASS — T6 risk list attached for tester reference
Ready for: next pipeline stage
```

## OpenClaw Integration

Run `$anvil` after any of these agent actions:

- After implementing a new extension or channel handler
- Before merging a PR (`$openclaw-pr-maintainer` calls this)
- After modifying plugin SDK interfaces (T5 contract check)
- Before any `pnpm build` gate

```bash
# Quick local gate (matches CI)
pnpm check && pnpm test -- <changed-files-pattern>
```

## Error Handling

| Error                | Resolution                               |
| -------------------- | ---------------------------------------- |
| No changed files     | Use `git diff HEAD~1 --name-only`        |
| T2 import fails      | Run `pnpm install` then retry            |
| T5 no contract found | Skip T5; note it explicitly              |
| Tier timeout         | Skip with TIMEOUT, log for investigation |

## Reflection Protocol

**Pre-Execution:** Which files changed? Is there story/task context for T4/T5? Should all 6 tiers run?

**Post-Execution:** Were findings real (not false positives)? Are all findings actionable? Was the handoff structured?

**Self-Score (1-10):**

- Thoroughness: No inappropriate skips? Re-run if <6.
- Accuracy: No false positives?
- Actionability: Each finding has clear fix instructions?

---

_The Anvil — Strike early. Strike often. Every handoff is a checkpoint._
