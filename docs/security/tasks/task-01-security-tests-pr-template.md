## Summary

Describe the problem and fix in 2–5 bullets:

- Problem: Security-sensitive media path handling had incomplete unit coverage for exfiltration-style inputs (`../`, absolute paths, `file://`, symlink escapes).
- Why it matters: Regressions in sandbox path validation could allow message actions to reference host files outside sandbox boundaries.
- What changed: Added focused unit tests in `src/agents/sandbox-paths.test.ts` and expanded sandbox validation tests in `src/infra/outbound/message-action-runner.test.ts`; added security task docs under `docs/security/tasks/`.
- What did NOT change (scope boundary): No production runtime logic changed; no auth, network, permissions, or API contract changes.

## Change Type (select all)

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor
- [x] Docs
- [x] Security hardening
- [ ] Chore/infra

## Scope (select all touched areas)

- [ ] Gateway / orchestration
- [x] Skills / tool execution
- [ ] Auth / tokens
- [ ] Memory / storage
- [ ] Integrations
- [ ] API / contracts
- [ ] UI / DX
- [ ] CI/CD / infra

## Linked Issue/PR

- Closes #TBD
- Related #TBD

## User-visible / Behavior Changes

None.

## Security Impact (required)

- New permissions/capabilities? (`Yes/No`): No
- Secrets/tokens handling changed? (`Yes/No`): No
- New/changed network calls? (`Yes/No`): No
- Command/tool execution surface changed? (`Yes/No`): No
- Data access scope changed? (`Yes/No`): No
- If any `Yes`, explain risk + mitigation: N/A

## Repro + Verification

### Environment

- OS: macOS (local dev)
- Runtime/container: Node 22+, pnpm 10.23
- Model/provider: N/A
- Integration/channel (if any): Message action path handling (Slack fixture in tests)
- Relevant config (redacted): N/A

### Steps

1. `pnpm install --frozen-lockfile`
2. `pnpm test:fast -- src/agents/sandbox-paths.test.ts src/infra/outbound/message-action-runner.test.ts`
3. Optional full lane: `pnpm canvas:a2ui:bundle && pnpm test`

### Expected

- New/updated security tests pass.
- Out-of-sandbox traversal, absolute, `file://`, and symlink escape cases are rejected.

### Actual

- In this session, dependency install failed due DNS/network (`ENOTFOUND registry.npmjs.org`), so tests could not be executed locally here.

## Evidence

Attach at least one:

- [ ] Failing test/log before + passing after
- [x] Trace/log snippets
- [ ] Screenshot/recording
- [ ] Perf numbers (if relevant)

Trace snippet:

- `ENOTFOUND request to https://registry.npmjs.org/... failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org`

## Human Verification (required)

What you personally verified (not just CI), and how:

- Verified scenarios: Reviewed and authored test coverage for traversal (`../`), absolute path outside root, `file://` outside root, `file://` inside root (allowed), symlink escape, and `MEDIA:` directive escape cases.
- Edge cases checked: Symlink creation permission handling (`EPERM`/`EACCES`/`ENOSYS`) and cross-platform file URL generation via `pathToFileURL`.
- What you did **not** verify: Local test execution in this environment (blocked by network dependency install failure).

## Compatibility / Migration

- Backward compatible? (`Yes/No`): Yes
- Config/env changes? (`Yes/No`): No
- Migration needed? (`Yes/No`): No
- If yes, exact upgrade steps: N/A

## Failure Recovery (if this breaks)

- How to disable/revert this change quickly: Revert commit `1d2e374fb66ace4db27d753f1c2c7993c23a034e`.
- Files/config to restore:
  - `src/agents/sandbox-paths.test.ts`
  - `src/infra/outbound/message-action-runner.test.ts`
  - `docs/security/tasks/*`
- Known bad symptoms reviewers should watch for: Test instability on platforms where symlink creation is restricted.

## Risks and Mitigations

- Risk: Symlink-related tests can be environment-sensitive.
  - Mitigation: Tests explicitly handle permission-restricted environments by short-circuiting expected cases.
- Risk: Tests were not executed locally in this session.
  - Mitigation: Run targeted Vitest commands above in CI/connected local environment before merge.
