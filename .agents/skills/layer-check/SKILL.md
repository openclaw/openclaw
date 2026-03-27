---
name: layer-check
description: Three-layer enforcement validator for OpenClaw changes — Core/Backend, Extension/Plugin, and CLI/Channel layers. Catches incomplete implementations, banned patterns, missing tests, and cross-layer consistency gaps. Ported from SkillFoundry.
---

# $layer-check — Three-Layer Enforcement

> "A mock is a lie you tell yourself. This system does not tolerate lies."
> "Three layers. Three gates. Zero exceptions."

## Invocation

```
$layer-check              Full three-layer validation
$layer-check core         Core/backend layer only
$layer-check extension    Extension/plugin layer only
$layer-check channel      Channel/CLI layer only
$layer-check scan         Banned pattern scan only
$layer-check audit        Generate audit log entry
```

## ZERO TOLERANCE: BANNED PATTERNS

Any code containing these patterns is **IMMEDIATELY REJECTED**:

```bash
# Run before any layer check
grep -rn "TODO\|FIXME\|HACK\|PLACEHOLDER\|STUB\|NOT IMPLEMENTED\|WIP\|TEMPORARY\|Lorem ipsum" \
  --include="*.ts" --include="*.js" \
  --exclude-dir=node_modules --exclude-dir=dist \
  --exclude="*.test.ts" --exclude="*.spec.*"
```

Banned behaviors (beyond keywords):

- Mock data in production code (not test files)
- Hardcoded credentials or tokens
- `any` type without justification comment
- `// @ts-ignore` without justification comment
- `eslint-disable` without justification
- Empty catch blocks (`catch {}`)
- `console.log` in production paths (use OpenClaw's `createSubsystemLogger`)

## LAYER 1: CORE / BACKEND

```
CORE LAYER CHECKLIST:
□ All changed functions have correct TypeScript types (no `any`)
□ Error handling uses OpenClaw patterns (createSubsystemLogger, not console.log)
□ Input validation at all entry points
□ No hardcoded credentials or tokens
□ Auth/permissions enforced server-side (not only gated in UI)
□ SSRF policy honored for any outbound HTTP calls
□ Parameterized queries / safe interpolation for any DB access
□ Timeouts on external service calls

EVIDENCE REQUIRED:
□ pnpm tsgo — no type errors in touched files
□ pnpm test -- <touched-files> — scoped tests pass
□ No new warnings in pnpm build output
```

## LAYER 2: EXTENSION / PLUGIN

```
EXTENSION LAYER CHECKLIST:
□ openclaw.plugin.json manifest is valid and complete
□ Plugin id matches directory name and package name
□ No workspace:* in dependencies (use devDependencies/peerDependencies)
□ No direct imports from core src/** (use openclaw/plugin-sdk/* only)
□ No cross-extension relative imports (../../other-extension)
□ Runtime deps in dependencies, build-only deps in devDependencies
□ Plugin lifecycle hooks (setup, teardown) handled cleanly
□ Channel capability matrix complete (if channel plugin)
□ DM policy and group policy defined (if channel plugin)

EVIDENCE REQUIRED:
□ pnpm check — passes in extension package
□ Extension builds cleanly: cd extensions/<id> && pnpm build
□ pnpm test -- extensions/<id> — extension tests pass
□ No [INEFFECTIVE_DYNAMIC_IMPORT] warnings after pnpm build
```

## LAYER 3: CLI / CHANNEL

```
CLI / CHANNEL LAYER CHECKLIST:
□ All new commands registered correctly (no stubs)
□ Command help text is accurate and complete
□ Channel setup wizard reaches completion (no placeholder steps)
□ No mock/static data returned to channel messages
□ Status output uses src/terminal/table.ts patterns
□ Progress uses src/cli/progress.ts (osc-progress / @clack/prompts)
□ No hardcoded colors (use src/terminal/palette.ts)
□ Messages to external channels are final (no streaming partial replies)

EVIDENCE REQUIRED:
□ openclaw <command> --help — output is correct
□ Manual or automated test of command flow
□ No console.log in channel message handlers
```

## ITERATION ENFORCEMENT

Every story/task completion MUST include:

### Documentation Gate

```
□ Public functions/exports have JSDoc comments explaining WHY
□ New config fields documented in config schema
□ If touching docs/: internal links use root-relative paths (no .md extension)
□ CHANGELOG updated (user-facing changes only, appended to end of section)
```

### Security Gate

```
□ No new secrets committed (run: git diff | grep -i "password\|secret\|token\|api_key")
□ Input sanitization on all user-controlled data
□ Auth tokens not logged
□ No dangerouslySetInnerHTML / eval() without sanitization
□ SSRF prevention for any URL-accepting code
```

### Audit Entry

```
| Date | Task | Layers | Security | Docs | Tests | Verdict |
|------|------|--------|----------|------|-------|---------|
| [date] | [task] | Core:✓ Ext:✓ CLI:✓ | ✓ | ✓ | ✓ | PASS |
```

## POST-IMPLEMENTATION VERDICT

```
┌─────────────────────────────────────────────────────────────┐
│ LAYER ENFORCEMENT VERDICT                                   │
├─────────────────────────────────────────────────────────────┤
│ Task: [description]                                         │
│ Date: [timestamp]                                           │
│                                                             │
│ CORE LAYER:                                                 │
│ ├─ Types: [✓/✗]                                             │
│ ├─ Tests: [✓/✗]                                             │
│ ├─ Security: [✓/✗]                                          │
│ └─ Status: [PASS/FAIL]                                      │
│                                                             │
│ EXTENSION LAYER:                                            │
│ ├─ Manifest Valid: [✓/✗]                                    │
│ ├─ Import Boundaries: [✓/✗]                                 │
│ ├─ Build Clean: [✓/✗]                                       │
│ └─ Status: [PASS/FAIL]                                      │
│                                                             │
│ CLI/CHANNEL LAYER:                                          │
│ ├─ Commands Complete: [✓/✗]                                 │
│ ├─ No Mock Data: [✓/✗]                                      │
│ ├─ Patterns Followed: [✓/✗]                                 │
│ └─ Status: [PASS/FAIL]                                      │
│                                                             │
│ ITERATION GATES:                                            │
│ ├─ Documentation: [✓/✗]                                     │
│ ├─ Security Scan: [✓/✗]                                     │
│ └─ Audit Log: [✓/✗]                                         │
│                                                             │
│ BANNED PATTERN SCAN: [CLEAN/VIOLATIONS]                     │
│                                                             │
│ ══════════════════════════════════════════════════════════ │
│ VERDICT: [APPROVED / REJECTED]                              │
│                                                             │
│ If REJECTED:                                                │
│ - [Specific failure reason with file:line]                  │
│ - [Required fix]                                            │
│ - [Re-validation instructions]                              │
└─────────────────────────────────────────────────────────────┘
```

## Integration with OpenClaw Pipeline

`$layer-check` runs automatically in:

- `$gate-keeper` validation (calls `$layer-check` before gate decision)
- `$anvil T4/T5` (scope + contract checks overlap with layer enforcement)
- `$openclaw-pr-maintainer` (bug-fix evidence bar requires layer validation)

For changes spanning all three layers (e.g., new channel + config + CLI):

```bash
# Full validation sequence
pnpm check                      # lint + types (all packages)
pnpm test                       # full suite
pnpm build                      # required for SDK/boundary changes
$layer-check                    # three-layer verdict
$anvil                          # 6-tier quality gate
```

## Reflection Protocol

**Pre-Execution:**

1. Which layers does this change affect?
2. Are banned pattern exclusions correct (not excluding production files)?
3. Are there recent migrations or SDK changes that affect layer integrity?

**Post-Execution:**

1. Did all affected layers pass independently?
2. Were banned patterns resolved (not just documented)?
3. Is the audit entry complete with evidence for each gate?
4. Are there cross-layer consistency gaps (e.g., CLI expects config fields extension doesn't expose)?

**Self-Score (0-10):**

- Layer Coverage: All affected layers validated with evidence?
- Banned Pattern Detection: Scan thorough, violations resolved?
- Cross-Layer Consistency: CLI/Extension/Core alignment verified?
- Gate Rigor: No shortcuts on documentation, security, or audit?

**If overall < 7.0:** Re-run failed layer checks before closing.
