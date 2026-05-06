## Summary

- Problem: `openclaw config set` dry-run validation could reject new bundled channel config keys when generated bundled-channel metadata lagged behind the plugin-owned schema.
- Problem: the scheduled live/E2E workflow also failed before dispatching its reusable workflow because the caller did not grant the callee's `prepare_docker_e2e_image` job `actions: read`.
- Why it matters: bundled plugins own their channel schemas, and config writes should validate against the live plugin contract instead of a stale core/generated copy.
- What changed: config-set dry runs now use plugin-aware raw validation, plugin channel validation no longer seeds schemas from `bundled-channel-config-metadata.generated.ts` before reading the live manifest registry, and scheduled live/E2E checks now pass `actions: read` to the reusable workflow call.
- What did NOT change (scope boundary): this PR does not move the remaining maintained bundled schema exports out of `openclaw/plugin-sdk/bundled-channel-config-schema`; that larger schema-ownership cleanup can happen separately.

## Change Type (select all)

- [x] Bug fix
- [ ] Feature
- [ ] Refactor required for the fix
- [ ] Docs
- [ ] Security hardening
- [x] Chore/infra

## Scope (select all touched areas)

- [ ] Gateway / orchestration
- [ ] Skills / tool execution
- [ ] Auth / tokens
- [ ] Memory / storage
- [x] Integrations
- [x] API / contracts
- [x] UI / DX
- [x] CI/CD / infra

## Linked Issue/PR

- Closes #69361
- Related #69193
- [x] This PR fixes a bug or regression

## Real behavior proof (required for external PRs)

- Behavior or issue addressed: config-set dry-run channel validation now follows live plugin-owned channel schema metadata.
- Real environment tested: local Linux checkout with Node 22.16.0 and pnpm 10.33.2, using an isolated `OPENCLAW_CONFIG_PATH`.
- Exact steps or command run after this patch: `OPENCLAW_CONFIG_PATH=/tmp/openclaw-69361-proof-MB14z7/openclaw.json pnpm openclaw config set channels.bluebubbles.sendTimeoutMs 45000 --strict-json --dry-run`
- Evidence after fix (screenshot, recording, terminal capture, console output, redacted runtime log, linked artifact, or copied live output): copied terminal output:

```text
> openclaw@2026.5.6 openclaw /home/ubuntu/Timon/openclaw
> node scripts/run-node.mjs config set channels.bluebubbles.sendTimeoutMs 45000 --strict-json --dry-run

Dry run successful: 1 update(s) validated against /tmp/openclaw-69361-proof-MB14z7/openclaw.json.
```

- Observed result after fix: the BlueBubbles `sendTimeoutMs` config-set dry run succeeded instead of rejecting the plugin-owned channel key as stale generated metadata.
- What was not tested: broad full-suite validation was not run locally.
- Before evidence (optional but encouraged): issue #69361 documents the original `channels.bluebubbles.sendTimeoutMs` rejection.

## Root Cause (if applicable)

- Root cause: the CLI config-set dry-run path called raw validation with `validateBundledChannels: true`, which validated bundled channel config against generated metadata instead of the live plugin-owned schema.
- Missing detection / guardrail: tests covered plugin-owned channel metadata defaults, but did not prove a bundled channel key accepted by the live plugin schema remains accepted when generated metadata lacks that key.
- Contributing context (if known): PR #69193 exposed the hidden sync requirement when BlueBubbles accepted `sendTimeoutMs` in the plugin schema but the runtime rejected it until generated/core metadata caught up.

## Regression Test Plan (if applicable)

- Coverage level that should have caught this:
  - [ ] Unit test
  - [x] Seam / integration test
  - [ ] End-to-end test
  - [ ] Existing coverage already sufficient
- Target test or file: `src/config/validation.channel-metadata.test.ts`
- Scenario the test should lock in: a bundled channel config key accepted by live plugin-owned schema metadata is accepted even when generated bundled metadata does not know that key.
- Why this is the smallest reliable guardrail: it exercises the config validation seam that combines core config validation with plugin registry channel schema metadata.
- Existing test that already covers this (if any): N/A
- If no new test is added, why not: N/A

## User-visible / Behavior Changes

`openclaw config set` no longer rejects newly added bundled plugin channel config keys merely because generated bundled-channel metadata is stale.

## Diagram (if applicable)

```text
Before:
openclaw config set -> raw generated bundled metadata -> stale schema rejection

After:
openclaw config set -> plugin-aware raw validation -> live plugin channel schema -> accepted
```

## Security Impact (required)

- New permissions/capabilities? (`Yes/No`) Yes, the scheduled live/E2E reusable workflow caller now grants `actions: read`, matching the callee job's existing least-privilege requirement.
- Secrets/tokens handling changed? (`Yes/No`) No
- New/changed network calls? (`Yes/No`) No
- Command/tool execution surface changed? (`Yes/No`) No
- Data access scope changed? (`Yes/No`) No
- If any `Yes`, explain risk + mitigation: `actions: read` only permits reading workflow/action metadata needed by the reusable workflow; the caller already had `contents: read`, `packages: write`, and secret pass-through for the live/E2E lanes.

## Repro + Verification

### Environment

- OS: local Linux checkout
- Runtime/container: not available in this environment
- Model/provider: N/A
- Integration/channel (if any): bundled channel config validation
- Relevant config (redacted): `channels.bluebubbles.pluginOwnedFutureKey`

### Steps

1. Mock a bundled `bluebubbles` manifest registry entry with live channel schema metadata that allows `pluginOwnedFutureKey`.
2. Validate config through `validateConfigObjectRawWithPlugins`.
3. Confirm validation succeeds.

### Expected

- Live plugin-owned channel schema metadata decides whether the channel key is valid.

### Actual

- The added regression test expects validation success for the live-schema-only key.

## Evidence

- [x] Failing test/log before + passing after
- [ ] Trace/log snippets
- [ ] Screenshot/recording
- [ ] Perf numbers (if relevant)

## Human Verification (required)

What you personally verified (not just CI), and how:

- Verified scenarios: reviewed the config-set dry-run path and plugin channel validation schema collection path; ran `git diff --check`; parsed `.github/workflows/openclaw-scheduled-live-checks.yml` and confirmed both top-level and reusable-call job permissions include `actions: read`.
- Edge cases checked: generated metadata remains available for existing unsupported SecretRef policy guidance, but is no longer used as the plugin validation fallback; scheduled live/E2E workflow permissions remain least-privilege and only add the callee-required `actions: read`.
- What you did **not** verify: `scripts/check-workflows.mjs`, because this shell does not have `actionlint` or Go available for its fallback.

## Review Conversations

- [x] I replied to or resolved every bot review conversation I addressed in this PR.
- [x] I left unresolved only the conversations that still need reviewer or maintainer judgment.

## Compatibility / Migration

- Backward compatible? (`Yes/No`) Yes
- Config/env changes? (`Yes/No`) No
- Migration needed? (`Yes/No`) No
- If yes, exact upgrade steps: N/A

## Risks and Mitigations

- Risk: plugin-aware dry-run validation may load plugin metadata where the previous raw generated check did not.
  - Mitigation: config writes already need plugin-owned channel schema contracts for correctness, and this path now matches the existing plugin validation seam.
