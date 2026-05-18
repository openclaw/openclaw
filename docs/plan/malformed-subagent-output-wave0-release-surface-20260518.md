# Malformed Subagent Output — Wave 0 Release Surface

Date: 2026-05-18
Plan: `/root/.openclaw/repos/openclaw-mds/handoffs/framework/current/malformed-subagent-output-fix-plan-2026-05-16.md`
Worktree: `/root/.openclaw/worktrees/openclaw-runtime-hardening-20260517`

## Scope and disposition

This Wave 0 artifact records release/build/package surfaces only. It does not authorize or perform Plan 2 runtime code edits. It does not require a live gateway restart, live config mutation, credential changes, cron changes, external messaging, or package/lockfile edits before checker review.

## Package manager and lockfile

- Package manager from `package.json`: `pnpm@11.1.0+sha512.0c44e842e5686b2c061a81adda8b2258bd8818e9704b2cf2c63d56b931a7b2e910092e085027003b96ca3911ab56a07f6df5abaed2be9925034cdd686a535b14`
- Lockfile: `pnpm-lock.yaml`
- Package config: `package.json`
- Wave 0 touched neither `package.json` nor `pnpm-lock.yaml`.
- Later waves must not modify package manager, package config, lockfile, generated assets, or release workflow unless the accepted implementation scope explicitly expands to that surface.

## Source build command

The source build command exposed by `package.json` is:

```bash
pnpm build
```

This resolves to:

```bash
node scripts/build-all.mjs
```

Related strict/release build scripts observed during source inspection include `build:strict-smoke` and `build:ci-artifacts`, but Wave 0 does not run broad builds. The focused baseline/post-wave commands are listed in `docs/plan/malformed-subagent-output-wave0-test-inventory-20260518.json`.

## Generated artifact policy

1. Bundled/generated/hashed `dist` artifacts are source-map breadcrumbs only for this plan.
2. Do **not** manually patch generated/bundled/hashed release outputs, including `dist/**`, bundled runtime output, generated schemas/assets, or build-stamp files.
3. Later source changes should be made in source/test files first.
4. If release process requires generated outputs, regenerate them only by the accepted source build command in a clean checkout and review the generated diff as build output, not hand-authored code.
5. If a later implementation discovers that P0 enforcement cannot proceed without generated artifact or package/lockfile changes, stop and report `BLOCKED_RELEASE_SURFACE`; do not patch them ad hoc.

## Clean-checkout reproduction steps

Use these steps for checker/release reproduction after later source/test waves are accepted:

```bash
git clone <openclaw-source-repo> openclaw-clean
cd openclaw-clean
corepack enable
corepack prepare pnpm@11.1.0 --activate
pnpm install --frozen-lockfile
# apply the accepted source/test patch; do not apply manual dist edits
OPENCLAW_TEST_FAST=1 node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts src/agents/subagent-child-result-contract.test.ts src/agents/subagent-active-task-contract.test.ts src/agents/subagent-announce-output.test.ts src/agents/subagent-announce.test.ts src/agents/internal-events.test.ts src/agents/compaction.test.ts src/agents/pi-hooks/compaction-safeguard.test.ts
OPENCLAW_TEST_FAST=1 node scripts/run-vitest.mjs run --config test/vitest/vitest.gateway.config.ts src/gateway/session-history-state.test.ts src/gateway/server.agent.subagent-delivery-context.test.ts src/gateway/protocol/schema/agent.test.ts
OPENCLAW_TEST_FAST=1 node scripts/run-vitest.mjs run --config test/vitest/vitest.unit-ui.config.ts ui/src/ui/chat/message-extract.test.ts ui/src/ui/controllers/chat.test.ts ui/src/ui/chat/build-chat-items.test.ts
pnpm build
git diff --check
```

For Wave 0 itself, only docs/plan artifacts and `/tmp` report/log files are expected to change. A broad build/check is intentionally not required before checker review because no runtime/package source was changed by Wave 0.

## Live runtime/config policy

- Live gateway config touched: no.
- Gateway restarted: no.
- Gateway restart required before continuing: no.
- Credentials/provider/channel config touched: no.
- Cron jobs touched: no.
- External messaging performed: no.

If a later wave requires live runtime restart/config mutation, stop and report it for parent/human decision; do not perform it from this task.

## Release risks for later waves

- Current worktree contains pre-existing dirty Plan 1/other-wave source and test files. Later implementations must avoid conflating those with Plan 2 changes.
- Current source already contains preliminary child-result/active-task/status-card constructs, but Plan 2 acceptance still requires the explicit `VERIFIED_PASS` evidence model and raw-output quarantine/sanitizer invariants.
- UI raw-open workflow, telemetry counters, historical polluted-session repair, and rollout thresholds are later-wave release surfaces, not Wave 0 blockers.
