## Summary

- **Problem:** `src/agents/skills.test.ts` can be flaky in CI because Claude bundle command discovery depends on the effective HOME / config-root used for plugin discovery; the test writes the bundle under a temp `~/.openclaw/extensions/...`, but the command loader may resolve a different HOME in the test environment and return no commands.
- **Why it matters:** This intermittently fails the agents/plugin shard (`commands` becomes `[]`), blocking unrelated PRs with red CI.
- **What changed:** Run the “enabled Claude bundle markdown commands” assertion under a path-resolution env rooted at the temp home (`tempHome.home`) so plugin discovery reliably finds the fixture bundle directory. Also make the command-name sort deterministic with `localeCompare` to satisfy the linter.
- **Scope boundary:** Test-only change; no runtime behavior changes to skill loading or plugin discovery—just stabilizes the unit test environment.

## Change Type (select all)

- [x] Bug fix
- [ ] Feature
- [ ] Refactor required for the fix
- [ ] Docs
- [ ] Security hardening
- [ ] Chore/infra

## Scope (select all touched areas)

- [ ] Gateway / orchestration
- [x] Skills / tool execution (tests)
- [ ] Auth / tokens
- [ ] Memory / storage
- [ ] Integrations
- [ ] API / contracts
- [ ] UI / DX
- [x] CI/CD / infra (CI stability via deterministic test env)

## Linked Issue/PR

- Closes #
- Related #
- [x] This PR fixes a bug or regression

## Root Cause (if applicable)

- **Root cause:** The test’s Claude bundle fixture is written under a temp `HOME`, but plugin discovery resolves the extensions root from HOME/config-dir; without forcing path-resolution env, the loader may look in a different place and return no bundle commands.
- **Missing guardrail:** Test didn’t pin the HOME/config-root used by plugin discovery.

## Regression Test Plan (if applicable)

- Coverage level:
  - [x] Unit test
  - [ ] Seam / integration test
  - [ ] End-to-end test
  - [ ] Existing coverage already sufficient
- Target test:
  - `pnpm test src/agents/skills.test.ts -- -t "includes enabled Claude bundle markdown commands"`

## User-visible / Behavior Changes

- None (test-only).

## Security Impact (required)

- New permissions/capabilities? `No`
- Secrets/tokens handling changed? `No`
- New/changed network calls? `No`
- Command/tool execution surface changed? `No`
- Data access scope changed? `No`

## Risks and Mitigations

- **Risk:** None beyond test behavior.
  - **Mitigation:** Change is scoped to the test environment setup; runtime code paths remain unchanged.
