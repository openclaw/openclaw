---
name: release-openclaw-plugin-testing
description: Plan and run pre-release OpenClaw plugin validation across bundled plugins, package artifacts, lifecycle commands, doctor/fix, config round-trip, gateway startup, SDK compatibility, Docker E2E, Package Acceptance, and Testbox proof.
---

# OpenClaw Pre-Release Plugin Testing

Use this skill when the user asks for plugin release confidence, plugin lifecycle
sweeps, package-artifact plugin proof, or "what else should we test before
release?" It complements `openclaw-testing`; use that skill too when choosing
the cheapest safe runner or debugging a failing lane.

## Goal

Prove the plugin system as a product surface, not just as source tests:

- bundled plugin lifecycle: install, inspect, enable, disable, uninstall
- package artifact behavior from a clean `HOME`
- doctor/fix/config validation and idempotence
- config discovery and config round-trip
- status/log visibility and diagnostics
- gateway startup/bootstrap with plugin metadata snapshots
- public SDK compatibility for real external plugins
- live-ish provider/channel probes only when safe credentials exist

## First Checks

From the OpenClaw repo root:

```bash
pnpm docs:list
git status --short --branch
pnpm changed:lanes --json
```

Follow [`openclaw-testing`](../openclaw-testing/SKILL.md) for dependency
ownership and the choice of local or remote proof.

## Runner Choice

Prefer this order:

1. **GitHub Package Acceptance** for installable-package product proof.
2. **Current dedicated Linux worker** for trusted source/package/Docker proof
   when it has the required dependencies and capabilities.
3. **`ci-build-artifacts-testbox.yml` Testbox** when Docker/package lanes need
   seeded `dist`, `dist-runtime`, and package caches.
4. **`ci-check-testbox.yml` Testbox** for source checks, targeted Vitest,
   package-boundary checks, or focused Docker lanes.
5. **Workstation targeted commands only** for small format/static/unit probes.

Avoid long package Docker runs from a stale sparse worktree. If Testbox sync
reports hundreds of changed files or starts deleting package inputs, stop and
warm a fresh box from current `main`, or switch to Package Acceptance.

## Existing Baseline

Run or verify these before inventing new coverage:

```bash
OPENCLAW_TESTBOX=1 pnpm check:changed
pnpm run test:extensions:package-boundary:canary
pnpm run test:extensions:package-boundary:compile
pnpm test:docker:plugins
OPENCLAW_PLUGINS_E2E_CLAWHUB=0 pnpm test:docker:plugins
pnpm test:docker:plugin-update
```

For full bundled install/uninstall proof, shard the packaged sweep:

```bash
OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL=8 \
OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX=<0-7> \
pnpm test:docker:bundled-plugin-install-uninstall
```

This example partitions the selected package's plugin inventory over shards `0-7`.
Private QA plugins are source-mode only unless a package explicitly includes
them.

## Confidence Matrix

Use this matrix for pre-release signoff. Record pass/fail, run URL/Testbox ID,
package SHA/version, and skipped-live reason.

| Surface           | Proof                                                           | Preferred runner                     |
| ----------------- | --------------------------------------------------------------- | ------------------------------------ |
| Package artifact  | Package Acceptance `suite_profile=package` or custom lanes      | GitHub Actions                       |
| Bundled lifecycle | Sharded `test:docker:bundled-plugin-install-uninstall`          | Testbox or release Docker            |
| External plugins  | `test:docker:plugins` and `plugins-offline`                     | Testbox/package acceptance           |
| Update no-op      | `test:docker:plugin-update`                                     | Testbox/package acceptance           |
| Doctor/fix        | seeded bad configs + `doctor --fix --non-interactive`           | new Docker/Testbox harness           |
| Config round-trip | `config set/get`, inspect, doctor, reload, diff hash            | new Docker/Testbox harness           |
| Gateway bootstrap | clean `HOME`, plugin groups enabled/disabled, status JSON       | new Docker/Testbox harness           |
| SDK compatibility | directory, tgz, and `file:` external plugins using SDK subpaths | `test:docker:plugins` plus new smoke |
| Live-ish          | redacted provider/channel probes only for present env           | Testbox live lanes                   |

## Package Acceptance Plan

Full Release Validation owns final candidate qualification with Q=C and the
exact publication tarballs. Use standalone Package Acceptance for diagnostics
or postpublish confidence, not as a replacement candidate qualification:

```bash
gh workflow run package-acceptance.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f workflow_ref=main \
  -f source=ref \
  -f package_ref=<branch-or-sha> \
  -f suite_profile=custom \
  -f docker_lanes='plugins-offline plugin-update doctor-switch update-channel-switch config-reload mcp-channels npm-onboard-channel-agent' \
  -f telegram_mode=mock-openai
```

Use `source=npm -f package_spec=openclaw@beta` for published beta proof. These
standalone diagnostic/confidence runs may use trusted current harness code;
candidate qualification must retain the frozen candidate's harness instead.

For extended-stable shared publication, require complete exact-target Full
Release Validation from the admitted candidate-owned `release-ci/*` harness at Q=C,
with trusted P admission and publication tooling separate. Direct
canonical-branch or `main` producers do not satisfy the protected publisher.
Package Acceptance is a post-publish selector smoke:

```bash
gh workflow run package-acceptance.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f workflow_ref=main \
  -f source=npm \
  -f package_spec=openclaw@extended-stable \
  -f suite_profile=package \
  -f telegram_mode=mock-openai
```

Record the resolved version. Still verify every package and selector in the
tag's `all-publishable` inventory; one smoke is not registry readback.

## Plugin npm Artifact Qualification

For a publication candidate, Full Release Validation owns plugin npm artifact
qualification. Supply its publication selection at dispatch; the all-group
parent invokes `plugin-npm-release.yml` in artifact-only mode against the exact
Release SHA, requires successful tarball readback, and records the immutable
aggregate descriptor in `publicationArtifacts.pluginNpm`. Release Prepare and
publication must adopt that exact descriptor rather than repacking plugins.

Use a standalone trusted-workflow preflight only for a focused diagnostic or a
selected-plugin repair that is outside a regular publication candidate:

```bash
release_sha="$(git rev-parse origin/release/2026.7.1)"
gh workflow run plugin-npm-release.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f preflight_only=true \
  -f publish_scope=selected \
  -f plugins=@openclaw/meta-provider \
  -f ref="${release_sha}" \
  -f npm_dist_tag=default
```

Do not pass `release_publish_run_id`. Require the workflow to finish
`verify_plugin_npm_preflight` successfully. Record the run URL, workflow SHA,
and source SHA. The workflow first creates the staging/readback artifact
`plugin-npm-package-source-<source-sha>-<extension-id>` containing
`npm-pack.json`, `preflight-manifest.json`, and the tarball. It then uploads the
final consumer artifact
`plugin-npm-package-<extension-id>-<version>-<route>-<run-id>-<attempt>` containing
the tarball and `plugin-publication-manifest.json`.

Record the final artifact name and digest separately. The manifest uses
`openclaw.plugin-publication-artifact/v1` and records the target SHA, package
manifest hashes, publication route and policy, and tarball hashes and inventory.
This standalone proof is validation-only; it does not authorize or stage
publication and cannot replace Full Release Validation's manifest-bound
descriptor. The artifact inventory, rather than the unpacked source tree, is
the security and package-content boundary: source-only fixtures are irrelevant.
Package-owned test and fixture paths outside shipped runtime and skill assets
fail qualification; shipped runtime remains security-scanned. Bundled
`node_modules` stays with dependency evidence rather than plugin-source policy.
The separate `trusted_publisher_preflight=true` OIDC check requires a protected
`release-publish/<tooling-sha12>-<epoch>` dispatch tag and runs in `npm-publish`.
Real publication also requires that tooling tag; a direct human dispatch waits
for its `npm-release` approval job before publishing.
For an already-published version,
require npm `dist.integrity` and `dist.shasum` to match the verified tarball.
Treat only missing or provably older dist-tags as repairable; newer or
incomparable selectors are a blocker.

## New Testbox Harness Plan

If more certainty is needed, add or run a `plugin-lifecycle-matrix` Docker lane
that uses one package tarball and sharded plugin lists. Per plugin:

1. Start with a clean `HOME`.
2. Capture `plugins list --json`.
3. `plugins install <id>`.
4. `plugins inspect <id> --json`.
5. `plugins disable <id>`, then assert disabled visibility.
6. `plugins enable <id>`, except config-required plugins without config.
7. `plugins registry --refresh`.
8. `doctor --non-interactive`.
9. `plugins uninstall <id> --force`.
10. Assert the plugin's `plugins.entries` value is exactly `{ enabled: false }`,
    while its allow/deny entries, install record, managed directory, and bundled
    runtime load paths are gone. Use the existing harness's source-qualified
    uninstall expectations for historical targets.
11. Assert diagnostics contain no `level: "error"` and output redacts
    secret-looking values.

Keep `memory-lancedb` special: it is config-required. First assert install does
not enable it without embedding config, then run a second configured case.

## Doctor/Fix Matrix

Seed bad states and require `doctor --fix --non-interactive` to repair them,
then run doctor again and require idempotence:

- stale `plugins.allow`
- stale `plugins.entries`
- stale channel config for missing channel plugin
- invalid `plugins.entries.<id>.config`
- packaged bundled path in `plugins.load.paths`
- legacy `plugins.installs`
- disabled channel/plugin config that must not stage runtime deps
- root-owned global package tree that must remain unmodified

## Gateway Bootstrap Matrix

Start packaged OpenClaw in Docker with clean state:

- provider plugins enabled, no credentials: ready with warnings, no crash
- channel plugins configured disabled: no runtime deps staged
- startup-activation plugins enabled: ready and reflected in status
- invalid single plugin config: bad plugin skipped/quarantined, others remain

Assert:

- gateway reaches ready
- `openclaw status --json` includes plugin diagnostics
- `openclaw plugins inspect --all --json` is parseable
- package tree is not mutated
- logs contain no raw tokens

## Config Round-Trip Representatives

Use representative plugin families instead of every plugin for deep config
round-trip:

- providers: `openai`, `anthropic`, `mistral`, `openrouter`
- channels: `telegram`, `discord`, `slack`, `whatsapp`
- memory: `memory-lancedb`
- feature/runtime: `browser`, `acpx`, `tokenjuice`

For each representative:

1. Write config through CLI when possible.
2. Read it back through `config get` or JSON.
3. Run `plugins inspect`.
4. Run `doctor --non-interactive`.
5. Trigger gateway config reload if applicable.
6. Compare config hash before/after no-op commands.

## External SDK Smoke

In a package Docker lane, create tiny external plugins and install them from:

- local directory
- `.tgz`
- `file:` npm spec

Cover CJS and ESM shapes, plus at least one plugin importing focused
`openclaw/plugin-sdk/*` subpaths. Assert `plugins inspect` sees its tool,
gateway method, CLI command, or service.

## Live-Ish Probe Rules

Before live-ish work, source allowed env in Testbox and generate a redacted
availability matrix: present/missing only, never values.

Only run probes for credentials that exist. Prefer auth/catalog/status probes
over sending user-visible messages. If a probe might contact an external user,
channel, or workspace, stop and ask the user.

## Reporting

Report in this shape:

```text
package/ref:
tbx ids / run urls:
matrix:
  bundled lifecycle:
  package acceptance:
  doctor/fix:
  gateway bootstrap:
  config round-trip:
  sdk external:
  live-ish:
failures:
skips:
next highest-value gap:
```

Say clearly when a failure is Testbox sync/env damage rather than product
behavior, and prove that with a clean rerun or current-main comparison.
