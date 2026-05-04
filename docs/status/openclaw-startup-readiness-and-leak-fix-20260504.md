# OpenClaw Startup Readiness And Leak Fix - 2026-05-04

## Current Truth

- Incident inputs confirmed Discord front-channel leakage of internal execution/commentary-like traces and Gateway startup instability in the same window.
- Observed bad startup keywords from local operator evidence:
  - `gateway event loop readiness timeout`
  - `discord: gateway was not ready after 15000ms; restarting gateway`
  - `sessions.list` requests around 40 seconds
  - `exit 78` with systemd `RestartPreventExitStatus=78`
- This source fix addresses the startup terminal-fail path and Discord final outbound leakage guard. It does not restart any running Gateway by itself.

## Code Changes

- Startup control-plane load shedding:
  - Added `sessions.list` to `STARTUP_UNAVAILABLE_GATEWAY_METHODS`.
  - During sidecar startup, Gateway now returns retryable startup `UNAVAILABLE` for `sessions.list` instead of dispatching the costly session scan path.
- Native approval bootstrap readiness handling:
  - Changed approval-client readiness failure text away from the production incident keyword.
  - Changed exec-approval runtime readiness failure text away from the production incident keyword.
  - Classified gateway readiness/startup close errors as retryable bootstrap deferrals.
  - Normalized legacy readiness-timeout errors before logging retry deferrals, so old incident keywords do not reappear in native-approval retry logs.
  - Native approval handler startup now warns and retries instead of emitting the old terminal-looking `failed to start native approval handler` path for readiness-only failures.
- Discord gateway READY wait:
  - Replaced the one-restart-then-throw startup behavior with reconnect plus 2 second backoff until READY, stop, or abort.
  - Removed the old log string `gateway was not ready after 15000ms; restarting gateway` from the nonfatal retry path.
- Discord final outbound safety filter:
  - Added `extensions/discord/src/monitor/reply-safety.ts`.
  - `deliverDiscordReply` sanitizes payload text at the final Discord send boundary.
  - The filter uses the existing assistant-visible-text sanitizer, strips standalone internal trace/channel lines outside code fences, drops pure-internal text-only payloads, and preserves media-only payloads.

## Why This Should Work

- The startup window no longer allows Control UI `sessions.list` polling to compete with sidecar/channel readiness through the expensive session listing path.
- Discord READY timeout no longer escalates a transient event-loop stall into a thrown startup failure after a single reconnect attempt.
- Approval handler readiness failures are treated as recoverable gateway-readiness deferrals, matching the actual failure mode from the incident.
- Leakage protection is placed at the last Discord send boundary, so upstream mistakes in agent output assembly, commentary routing, or tool-call formatting get one final scrub before front-channel delivery.

## Modified Files

- `src/gateway/server-startup-unavailable-methods.ts`
- `src/gateway/operator-approvals-client.ts`
- `src/infra/approval-handler-bootstrap.ts`
- `src/infra/approval-handler-bootstrap.test.ts`
- `src/infra/exec-approval-channel-runtime.ts`
- `src/infra/exec-approval-channel-runtime.test.ts`
- `extensions/discord/src/monitor/provider.lifecycle.ts`
- `extensions/discord/src/monitor/provider.lifecycle.test.ts`
- `extensions/discord/src/monitor/reply-delivery.ts`
- `extensions/discord/src/monitor/reply-delivery.test.ts`
- `extensions/discord/src/monitor/reply-safety.ts`
- `docs/status/openclaw-startup-readiness-and-leak-fix-20260504.md`

## Validation

- `node scripts/run-vitest.mjs run --config test/vitest/vitest.extension-discord.config.ts extensions/discord/src/monitor/provider.lifecycle.test.ts extensions/discord/src/monitor/reply-delivery.test.ts`
  - Passed: 2 files, 28 tests.
- `OPENCLAW_GATEWAY_PROJECT_SHARDS=1 node scripts/run-vitest.mjs run --config test/vitest/vitest.gateway.config.ts src/gateway/server-methods.control-plane-rate-limit.test.ts`
  - Passed: 1 file, 12 tests.
- `node scripts/run-vitest.mjs run --config test/vitest/vitest.infra.config.ts src/infra/approval-handler-bootstrap.test.ts src/infra/exec-approval-channel-runtime.test.ts`
  - Passed: 2 files, 30 tests.
- `git diff --check`
  - Passed.

## Acceptance Log Keywords

- Must stay absent during the 30-60 minute post-deploy startup soak:
  - `gateway event loop readiness timeout`
  - `discord: gateway was not ready after 15000ms; restarting gateway`
  - `discord gateway did not reach READY within 15000ms after restart`
  - `sessions.list` with 40 second scale durations
  - `exit 78`
- Expected nonterminal readiness retry keyword if Discord is slow to become READY:
  - `discord: gateway READY wait timed out after 15000ms; reconnecting with backoff`
- Expected approval bootstrap deferral keyword if Gateway is still starting:
  - `native approval handler deferred until gateway readiness recovers`

## Risks

- `sessions.list` is temporarily unavailable during startup until sidecars clear startup gating. Control UI must retry retryable `UNAVAILABLE` responses.
- The Discord READY wait can keep reconnecting until stop/abort. If credentials or network are truly broken, operator-visible status remains `startup-not-ready` instead of crashing the Gateway.
- The final outbound scrub intentionally removes standalone internal trace lines. A user-visible reply that literally begins with `analysis:`, `commentary:`, or tool execution labels outside a code fence will be stripped from Discord text. Code-fenced examples are preserved.

## Rollback

- Source rollback: `git revert <commit-hash>` from this repo.
- If already deployed, rebuild/reinstall the reverted source using the normal OpenClaw packaging path, then restart the Gateway using the operator's configured service manager.

## Next Action

- Deploy this source build to an isolated or production-managed OpenClaw path.
- Run a 30-60 minute startup soak with Control UI open and Discord connected.
- During the soak, watch `/tmp/openclaw/openclaw-2026-05-04.log` or the active daily log for the acceptance keywords above.
