# BrightBid upstream migration plan

## Status

Target branch: `brightbid/upstream-main-upgrade`

Base repo: `HMarcusWH/openclaw`
Base branch: `main`
Base commit: `b32d4c5255c5d3ad089bf9a8c6dc25cf9e46c563`

Source repo: `HMarcusWH/openclawBBversion`
Source branch: `main`

## Purpose

Move the BrightBid control-plane layer from the older `openclawBBversion` snapshot onto the current OpenClaw main runtime without downgrading host-level runtime, plugin SDK, release, security, diagnostics, or workflow changes.

## Core rule

OpenClaw main wins as host/runtime substrate.
BrightBid wins as overlay/control-plane branch.

Do not blindly overwrite host files from `openclawBBversion`.

## Port allow-list

Bring forward only BrightBid-owned overlays:

```text
docs/build/
docs/brightbid/
docs/reference/brightbid*.md
docs/security/brightbid-threat-model.md
extensions/brightbid-control-plane/
src/brightbid/
scripts/brightbid/
LAUNCH.md
RELEASE_MANIFEST.json
.github/workflows/brightbid-gate.yml
```

## Do-not-overwrite list

Do not copy these from `openclawBBversion` over current OpenClaw main:

```text
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
src/plugins/
src/plugin-sdk/
src/agents/
src/gateway/
src/config/
test/helpers/
.github/workflows/ except brightbid-gate.yml
docs/plugins/
docs/reference/ except BrightBid-specific docs
security/ except docs/security/brightbid-threat-model.md
scripts/ except scripts/brightbid/
```

## Required compatibility patches

### 1. Remove obsolete embedded extension factory API

OpenClaw main removed the old embedded-extension factory path. BrightBid must remove:

```ts
api.registerEmbeddedExtensionFactory(...)
```

Affected BrightBid files from source branch:

```text
extensions/brightbid-control-plane/index.ts
extensions/brightbid-control-plane/runtime-api.ts
extensions/brightbid-control-plane/openclaw.plugin.json
```

Migration action:

```text
- Delete runtime-api.ts if it only exists for embedded-extension registration.
- Remove the import from index.ts.
- Remove the registerEmbeddedExtensionFactory call.
- Remove embeddedExtensionFactories from openclaw.plugin.json.
```

### 2. Promote BrightBid hard gate to trusted tool policy

Use OpenClaw main host policy surface:

```ts
api.registerTrustedToolPolicy({
  id: "brightbid-arbiter-policy",
  description: "BrightBid host-trusted pre-tool policy for tenant, evidence, freshness, policy, approval, and write-boundary governance.",
  evaluate(event, ctx) {
    // run BrightBid Arbiter / policy-bundle decision here
  },
});
```

Ordinary `before_tool_call` / `after_tool_call` hooks should remain for DecisionRecord, approval lifecycle, outcome logging, and cleanup.

### 3. Fix runtime Arbiter envelope parsing

The runtime policy path must carry every policy-relevant BrightBid proposal field, including:

```text
targetRelaxDeltaPct
newEntityDetected
deleteEntityDetected
pauseCount
coveragePct
secretEgressAttempt
unsafeToolPattern
subagentCount
brandSafetyViolation
executionOutcome
rollbackAvailable
```

Tests must cover these fields through:

```text
params -> parseProposalFromParams -> evaluateBrightBidToolPolicy -> trusted policy result
```

not only by direct Arbiter-unit tests.

### 4. Update plugin test helpers

Replace old helper imports such as:

```ts
../../test/helpers/plugins/plugin-api.js
```

with current OpenClaw plugin SDK test helper imports, normally:

```ts
../../src/plugin-sdk/plugin-test-api.js
```

or the current package export path if tests are moved outside the repo tree.

### 5. Merge package scripts without downgrading package metadata

Keep current OpenClaw `package.json` and add only BrightBid scripts:

```json
{
  "brightbid:baseline:gen": "node scripts/brightbid/generate-baseline-manifest.mjs",
  "brightbid:baseline:check": "node scripts/brightbid/validate-baseline-manifest.mjs",
  "brightbid:baseline:check:dev": "node scripts/brightbid/validate-baseline-manifest.mjs --profile dev",
  "brightbid:baseline:check:staging": "node scripts/brightbid/validate-baseline-manifest.mjs --profile staging",
  "brightbid:baseline:check:prod": "node scripts/brightbid/validate-baseline-manifest.mjs --profile prod"
}
```

## Release integration

BrightBid gates should run as an extra lane inside OpenClaw release validation:

```text
pnpm typecheck
pnpm test -- extensions/brightbid-control-plane
pnpm brightbid:baseline:check
pnpm deps:sbom-risk:check
pnpm plugins:boundary-report
```

## Acceptance checklist

```text
[ ] BrightBid files ported from allow-list only.
[ ] OpenClaw package version remains current main, not 2026.4.22.
[ ] No registerEmbeddedExtensionFactory references remain.
[ ] No embeddedExtensionFactories manifest contract remains.
[ ] BrightBid registers brightbid-arbiter-policy via registerTrustedToolPolicy.
[ ] Trusted policy returns host-compatible decision fields only.
[ ] DecisionRecord/audit hooks still run.
[ ] Full Arbiter envelope is parsed through runtime policy path.
[ ] Tests use current OpenClaw plugin SDK helpers.
[ ] BrightBid baseline scripts exist in package.json.
[ ] BrightBid gate is wired into release validation.
[ ] Release manifest source IDs are reconciled.
[ ] No live-write release claim until execution adapters, rollback executor, durable audit, and data plane P0s are closed.
```

## P0s that remain after migration

```text
Google Ads adapter
Microsoft Ads adapter
Meta Ads adapter
rollback executor
persistent execution_jobs / rollback_jobs
durable audit store
Slack concrete approval bridge
Teams concrete approval bridge
warehouse / RLS / evidence data plane
policy bundle signing/signoff
auxiliary import-gate evidence
```

## Final posture

After this migration, the correct label is:

```text
BrightBid control-plane upgraded to current OpenClaw host substrate.
Not yet live-write capable until execution/data-plane P0s close.
```
