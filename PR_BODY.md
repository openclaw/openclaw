## Summary

Describe the problem and fix in 2–5 bullets:

- Problem: `openai/gpt-5.4` could fail runtime resolution as an unknown model when the bundled catalog/registry only exposed `gpt-5.2`.
- Why it matters: users could set a `gpt-5.4` default model in config, but still hit runtime/model-check friction.
- What changed: added OpenAI `gpt-5.4` forward-compat fallback (template-cloned from `gpt-5.2`), catalog fallback synthesis, updated canonical OpenAI default alias/help/list examples to include `gpt-5.4`, and expanded tests.
- What did NOT change (scope boundary): no provider auth flow changes, no removal of `gpt-5.2` support, no docs site content changes.

## Change Type (select all)

- [x] Bug fix
- [x] Feature
- [ ] Refactor
- [ ] Docs
- [ ] Security hardening
- [ ] Chore/infra

## Scope (select all touched areas)

- [x] Gateway / orchestration
- [x] Skills / tool execution
- [ ] Auth / tokens
- [ ] Memory / storage
- [x] Integrations
- [x] API / contracts
- [x] UI / DX
- [ ] CI/CD / infra

## Linked Issue/PR

- Closes #N/A
- Related #N/A

## User-visible / Behavior Changes

List user-visible changes (including defaults/config).  
If none, write `None`.

- `openai/gpt-5.4` now resolves through forward-compat instead of failing with `Unknown model` when `gpt-5.2` template metadata is available.
- Model catalog now includes synthetic `openai/gpt-5.4` when `openai/gpt-5.2` exists, reducing false “not in catalog” warnings.
- Default alias handling now prefers `openai/gpt-5.4` for `gpt`, while preserving legacy fallback aliasing for `openai/gpt-5.2`.
- Tool allowlist help/examples now use `gpt-5.4` as canonical OpenAI example.
- `/thinking xhigh` support list now includes `openai/gpt-5.4`.

## Security Impact (required)

- New permissions/capabilities? (`Yes/No`): No
- Secrets/tokens handling changed? (`Yes/No`): No
- New/changed network calls? (`Yes/No`): No
- Command/tool execution surface changed? (`Yes/No`): No
- Data access scope changed? (`Yes/No`): No
- If any `Yes`, explain risk + mitigation: N/A

## Repro + Verification

### Environment

- OS: macOS (local dev workspace)
- Runtime/container: Node v25 + pnpm
- Model/provider: openai/gpt-5.4 (forward-compat from gpt-5.2 template)
- Integration/channel (if any): auto-reply directive tests + model catalog/runtime resolution
- Relevant config (redacted): `agents.defaults.model.primary: "openai/gpt-5.4"`

### Steps

1. Configure `agents.defaults.model.primary` to `openai/gpt-5.4`.
2. Resolve model/runtime paths and run targeted tests.
3. Verify no unknown-model failures and legacy `gpt-5.2` behavior remains intact.

### Expected

- `openai/gpt-5.4` is accepted in config/model resolution paths and runs without unknown-model failure.

### Actual

- Forward-compat + catalog fallback accept `openai/gpt-5.4`; targeted tests pass.

## Evidence

Attach at least one:

- [x] Failing test/log before + passing after
- [ ] Trace/log snippets
- [ ] Screenshot/recording
- [ ] Perf numbers (if relevant)

## Human Verification (required)

What you personally verified (not just CI), and how:

- Verified scenarios: ran targeted tests covering forward-compat resolution, catalog fallback, alias defaults, thinking support matrix, and directive behavior.
- Edge cases checked: legacy `openai/gpt-5.2` alias compatibility remains; non-forward-compat IDs still return unknown-model in existing tests.
- What you did **not** verify: live provider API calls against real OpenAI credentials.

## Compatibility / Migration

- Backward compatible? (`Yes/No`): Yes
- Config/env changes? (`Yes/No`): No
- Migration needed? (`Yes/No`): No
- If yes, exact upgrade steps: N/A

## Failure Recovery (if this breaks)

- How to disable/revert this change quickly: revert this PR commit.
- Files/config to restore: `src/agents/model-forward-compat.ts`, `src/agents/model-catalog.ts`, `src/config/defaults.ts`, `src/auto-reply/thinking.ts`.
- Known bad symptoms reviewers should watch for: unexpected fallback metadata for `openai/gpt-5.4` or regressions in alias assignment.

## Risks and Mitigations

List only real risks for this PR. Add/remove entries as needed. If none, write `None`.

- Risk: synthetic fallback metadata for `gpt-5.4` could diverge from future upstream catalog details.
  - Mitigation: fallback only applies when upstream template exists; once upstream publishes native `gpt-5.4`, native entries take precedence.
- Risk: changing canonical alias target could alter where `gpt` points in mixed allowlists.
  - Mitigation: explicit legacy fallback keeps `gpt` alias on `openai/gpt-5.2` when `gpt-5.4` is absent.
