# AGENTS.md

Scope: `qa/**`.

## Maturity Mapping

- `taxonomy.yaml` is the maturity taxonomy source: surfaces, categories, levels, and LTS slice.
- `taxonomy-mappings.yaml` is the executable overlay: coverage IDs, scenario refs, docs/code refs, and `smoke-ci` / `release` profile membership.
- Keep profiles to:
  - `smoke-ci`: deterministic PR/merge evidence, no live external services.
  - `release`: Stable/LTS evidence, live only where the claim depends on a real upstream or release artifact.
- `--surface` and `--category` filter a selected profile. They are not separate selectors or taxonomy sources.
- Advisory evidence is report-only unless explicitly promoted into `smoke-ci` or `release`.
- Do not maintain profile membership in workflow YAML when it can be read from `taxonomy-mappings.yaml`.

## QA Scenarios

- Scenario files live under `qa/scenarios/**` and are consumed by QA Lab.
- Keep coverage metadata stable. Use `coverage.primary` for the scorecard category's main coverage IDs and `coverage.secondary` for supporting proof.
- `docsRefs`, `codeRefs`, and `scenarioRefs` are repo-root relative paths.
- When adding a scenario for maturity proof, update `taxonomy-mappings.yaml` in the same change or leave the scorecard gap explicit.
- Do not put secrets, raw credentials, phone numbers, or unredacted transcripts in scenarios or evidence artifacts.

## Commands

- Find coverage: `pnpm openclaw qa coverage --match <surface-or-coverage-id>`.
- Get machine-readable coverage: `pnpm openclaw qa coverage --json --match <surface-or-coverage-id>`.
- Run mapped smoke proof: `pnpm openclaw qa run --profile smoke-ci --category <category-id> --provider-mode mock-openai --output-dir .artifacts/qa-e2e/<lane>`.
- Run mapped release proof only when live credentials and package/ref prerequisites are available: `pnpm openclaw qa run --profile release --category <category-id> --output-dir .artifacts/qa-e2e/<lane>`.
- In Codex worktrees, use `node scripts/run-vitest.mjs <explicit-test-files>` for focused QA Lab unit proof.

## Evidence

- `qa suite` writes `qa-suite-summary.json`; mapped `qa run` dispatches through `qa suite`.
- Normalized summaries include an `evidence` block with `kind`, `schemaVersion`, `generatedAt`, and `entries`.
- Evidence entries carry scenario IDs, coverage IDs, source/docs/code refs, scorecard surface/category IDs, profile, provider/model live state, channel/driver live state, runner, package source, environment, artifact paths, status, failure, and timing.
- Evidence summaries do not copy taxonomy provenance. Join evidence to maturity state through `taxonomy-mappings.yaml` and `taxonomy.yaml`.

## Validation

- For mapping/report edits, run `node scripts/run-vitest.mjs extensions/qa-lab/src/coverage-report.test.ts`.
- For profile dispatch edits, run `node scripts/run-vitest.mjs extensions/qa-lab/src/cli.test.ts extensions/qa-lab/src/cli.runtime.test.ts src/cli/profile.test.ts`.
- For evidence summary edits, run `node scripts/run-vitest.mjs extensions/qa-lab/src/evidence-summary.test.ts extensions/qa-lab/src/suite.summary-json.test.ts`.
- Always run `git diff --check` before handoff.
