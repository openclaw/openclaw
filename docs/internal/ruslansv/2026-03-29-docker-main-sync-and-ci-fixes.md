---
title: "Docker main sync and CI fixes"
summary: "Merged latest main into the Docker/mac branch, fixed several CI regressions, and rebuilt the local Docker gateway."
author: "Ruslan Belkin"
github_username: "ruslansv"
created: "2026-03-29"
---

This note captures the follow-up work after syncing `ruslan/docker-mac-fixes` with the latest `main`.

What changed:

- merged the latest `upstream/main` into `ruslan/docker-mac-fixes`
- rebuilt and redeployed the local Docker gateway from the merged branch
- fixed config runtime snapshot invalidation so `loadConfig()` does not reuse a stale snapshot after the temp home or config path changes
- restored `clearConfigCache()` so it actually clears the runtime config snapshot again
- fixed MiniMax portal catalog discovery to use `resolveProviderAuth(..., { oauthMarker })` instead of directly probing the auth store
- fixed ACP task-registry behavior so records created already in a terminal state immediately enter the normal delivery pipeline
- updated the nodes-run approval-timeout regression test to follow the current approval default instead of hardcoding `130_000`
- fixed Zalo lifecycle test mocking by mocking the source modules directly
- simplified Zalo/ZaloUser outbound test harnesses so they use local send mocks instead of depending on mocked bundled test-api send functions

Verification completed locally:

- `pnpm check`
- `pnpm build`
- `pnpm test -- src/config/config.identity-defaults.test.ts src/config/config.pruning-defaults.test.ts src/cli/nodes-cli/register.invoke.nodes-run-approval-timeout.test.ts src/tasks/task-registry.test.ts`
- `pnpm test -- src/plugins/contracts/discovery.contract.test.ts -t 'MiniMax portal oauth marker fallback provider-owned'`
- `pnpm test -- extensions/minimax/provider-discovery.contract.test.ts`
- `pnpm test -- extensions/matrix/src/plugin-entry.runtime.test.ts`
- `pnpm test -- extensions/zalo/src/monitor.reply-once.lifecycle.test.ts`

Remaining local gap:

- `pnpm test -- extensions/zalo/src/outbound-payload.contract.test.ts` still hangs on this macOS host before any test output appears. The earlier Linux CI failure was a concrete `sendMock.mockReset is not a function` regression, which the harness change addresses, but this specific file still needs CI confirmation after push.

Operational note:

- the rebuilt Docker gateway is healthy after redeploy and responds on `http://127.0.0.1:18789/healthz`

Second sync later the same day:

- merged `upstream/main` again after `main` moved another 80 commits
- resolved merge conflicts in:
  - `extensions/zalo/test-support/monitor-mocks-test-support.ts`
  - `src/cli/nodes-cli/register.invoke.approval-transport-timeout.test.ts`
  - `src/tasks/task-registry.ts`
- kept the Docker/Mac branch behavior that immediately re-runs task terminal delivery for newly created terminal task records, which preserves the restored-ACP delivery fix
- aligned the renamed Zalo test-support import with the new shared plugin-registry helper while preserving the `runtime-api` type surface

Verification for the second sync:

- `pnpm check`
- `pnpm build`
- `pnpm test -- src/cli/nodes-cli/register.invoke.approval-transport-timeout.test.ts src/tasks/task-registry.test.ts src/tasks/task-registry.store.test.ts`
- `OPENCLAW_INSTALL_URL=https://openclaw.ai/install.sh OPENCLAW_INSTALL_CLI_URL=https://openclaw.ai/install-cli.sh pnpm test:install:smoke`

Observed gap:

- `pnpm test -- extensions/zalo/src/monitor.reply-once.lifecycle.test.ts` hung under the wrapper on this macOS host, so the Zalo helper conflict was covered by the full `pnpm build` gate instead of a passing lifecycle test run
