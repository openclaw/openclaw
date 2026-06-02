# Velanir OpenClaw Fork Notes

This fork exists to keep Velanir's machine-install runtime close to upstream
OpenClaw while supporting Velanir workspace bootstrap files and the Velanir
participation gate extension needed by customer digital coworkers.

Companion platform decision record:
`docs/plans/velanir-openclaw-runtime-plan.md` in the Velanir platform repo.

Companion platform maintenance runbook:
`docs/runbooks/openclaw-fork-maintenance.md` in the Velanir platform repo.

On Dan's development machine, this checkout
(`/Users/danbotero/Developer/forked-openclaw`) is the retained Velanir fork
checkout. `/Users/danbotero/Developer/openclaw` is an upstream study clone only.
Do not recreate long-lived local worktrees for this patch unless there is a
clear temporary reason.

## Current fork-owned behavior

- Keep the npm package metadata as `openclaw`.
- Publish machine-install artifacts to S3 as `velanir-openclaw-<version>.tgz`.
- Preserve the generic `bootstrap-extra-files.allowedBasenames` config seam.
- Keep the fork branch focused on the small Velanir runtime delta:
  `bootstrap-extra-files.allowedBasenames` plus the bundled
  `velanir-participation-gate` extension.
- Bundle `extensions/velanir-participation-gate` into the normal OpenClaw
  runtime artifact instead of installing it ad hoc from the platform monorepo.
  This keeps customer machines on one versioned S3 artifact and avoids hidden
  private workspace package dependencies.

## Release workflow notes

The Velanir S3 release workflow intentionally keeps package metadata as
`openclaw` and renames only the uploaded S3 artifact. Its `npm pack --json`
step must tolerate lifecycle output around the JSON payload; keep that parser
aligned with OpenClaw's normal npm release workflow if upstream changes it.

The workflow has a manual `workflow_dispatch` tag input so a fixed workflow can
publish an existing tag after a failed tag-triggered run without deleting or
recreating the tag.

## Merge guidance

When updating from upstream OpenClaw, preserve an equivalent opt-in mechanism
for custom bootstrap basenames. Do not hardcode Velanir filenames into
`VALID_BOOTSTRAP_NAMES` unless there is no other viable short-term option.

The platform config uses this seam so files such as `COMPANY.md`,
`ROLE_PROFILE.md`, `MANAGER.md`, `TEAM.md`, and `CONTACTS.md` can be included
in normal agent Project Context without rewriting the OpenClaw package identity.

If upstream accepts a generic replacement, prefer the upstream version and
remove this fork patch.

The participation gate is Velanir-specific product behavior. It uses
`before_dispatch` to decide whether a digital coworker should participate in
group/channel conversations, reads platform participation context with scoped
runtime DPoP auth, and fails open when context or classification is unavailable.
The extension is bundled but disabled by default; platform-rendered
`openclaw.json` must explicitly enable `plugins.entries.velanir-participation-gate`
for coworkers participating in the Phase 8 rollout.
Keep it bundled with the forked runtime artifact until there is a public
OpenClaw-native equivalent or a documented plugin distribution lane that can
preserve the same runtime identity guarantees.

## Verification

After changing this fork-owned seam, run:

```bash
pnpm test src/agents/workspace.load-extra-bootstrap-files.test.ts src/hooks/bundled/bootstrap-extra-files/handler.test.ts
pnpm tsgo:core
pnpm tsgo:extensions
node scripts/run-vitest.mjs run --config test/vitest/vitest.extensions.config.ts extensions/velanir-participation-gate/index.test.ts
node scripts/tsdown-build.mjs && node scripts/runtime-postbuild.mjs && node scripts/test-built-plugin-singleton.mjs
```
