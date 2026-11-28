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

Before planning, running, extending, or accepting lifecycle, doctor/fix, gateway,
config, or external SDK proof, read
[the lifecycle matrix](references/lifecycle-matrix.md) in full.

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

Full Release Validation owns candidate qualification at admitted Q and the exact
publication tarballs. Standalone Package Acceptance supplies diagnostics or
postpublish confidence. Before running or accepting it, read
[the Package Acceptance procedure](references/package-acceptance.md) in full.

## Plugin npm Artifact Qualification

Full Release Validation owns candidate plugin npm qualification and the immutable
publication descriptor; standalone preflights are validation-only. Before
running or accepting this proof, read
[the plugin artifact procedure](references/plugin-npm-artifacts.md) in full.

## New Testbox Harness Plan

Before planning, running, extending, or accepting lifecycle, doctor/fix, gateway,
config, or external SDK proof, read
[the lifecycle matrix](references/lifecycle-matrix.md) in full.

## Doctor/Fix Matrix

Before planning, running, extending, or accepting lifecycle, doctor/fix, gateway,
config, or external SDK proof, read
[the lifecycle matrix](references/lifecycle-matrix.md) in full.

## Gateway Bootstrap Matrix

Before planning, running, extending, or accepting lifecycle, doctor/fix, gateway,
config, or external SDK proof, read
[the lifecycle matrix](references/lifecycle-matrix.md) in full.

## Config Round-Trip Representatives

Before planning, running, extending, or accepting lifecycle, doctor/fix, gateway,
config, or external SDK proof, read
[the lifecycle matrix](references/lifecycle-matrix.md) in full.

## External SDK Smoke

Before planning, running, extending, or accepting lifecycle, doctor/fix, gateway,
config, or external SDK proof, read
[the lifecycle matrix](references/lifecycle-matrix.md) in full.

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
