---
summary: "Review, shadow-test, deploy, and roll back the Telegram Reliability v1 patch"
read_when:
  - Reviewing Telegram reliability changes
  - Preparing a local build from a fork
  - Investigating Telegram requests that were received but never answered
title: "Telegram Reliability v1 Runbook"
---

This runbook describes the safe review and rollout path for Telegram Reliability v1.
It is intentionally conservative: the patch improves observability and user-visible
failure reporting, but it must not automatically replay Telegram requests or mutate
gateway state.

## Scope

Telegram Reliability v1 covers four behaviors:

1. Record lightweight Telegram inflight state for each dispatched request.
2. Send explicit failure notices for timeout, provider/network, context, session-lock,
   and delivery failure classes.
3. Guard very long Telegram inputs when the current Telegram session is already large.
4. On Telegram runtime startup, mark stale non-terminal inflight records as interrupted
   and notify the original chat.

The patch does not:

- restart the gateway
- retry or replay interrupted requests
- automatically generate, load, or attach a handoff when `/new` is used
- cancel or clean tasks
- change models, bindings, config, secrets, or sessions
- call heavy task audit/show paths from Telegram hot code

Handoff is explicit. `/new` alone starts a fresh Telegram session without carrying
the previous task forward. Operators use `/handoff` in the old session and
`/resume latest` in the new session only when they want to continue the same task.
`/handoff` is user-requested semantic transfer, not a diagnostics flow: it can be
created at any token level, and token/session metadata is advisory rather than a
precondition.

## Review Checklist

Before building a package, reviewers should confirm:

- Inflight records store only a short prompt preview and hash, not full user prompts.
- Store writes are best-effort and do not block Telegram dispatch if they fail.
- Startup interrupted notifications are bounded and do not rerun any action.
- High-context input protection still allows short commands such as `/new`, `/handoff`,
  `/resume`, `/compact`, `/status`, `/stop`, and `/abort`.
- `/new` remains a clean break and does not implicitly generate or load a handoff.
- `/handoff` does not require gateway diagnostics, task audit, channel status, or a
  high-token threshold before saving a packet.
- Failure notices are short and do not expose provider secrets or stack traces.
- Tests cover completion, failure notification, long-input guard, startup interrupted
  notice, and the explicit handoff boundary.

## Local Validation

Run the narrow Telegram test set first:

```bash
corepack pnpm test \
  extensions/telegram/src/bot-message-dispatch.test.ts \
  extensions/telegram/src/bot.create-telegram-bot.test.ts
```

Then run formatting and type checks when the machine has enough headroom:

```bash
git diff --check
corepack pnpm tsgo:extensions
corepack pnpm tsgo:extensions:test
```

If the extension type checks time out locally, do not treat that alone as a production
approval. Re-run them in CI or a less loaded environment.

## Shadow Build

Use a fork branch and build a package without replacing the currently installed
OpenClaw package:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm pack
```

Keep the generated tarball path and the git commit hash together. Do not overwrite
the production global install until the package can answer basic local CLI checks.

## Pre-Deployment Snapshot

Before replacing a running installation, capture:

```bash
openclaw --version
openclaw gateway status
openclaw gateway probe --json
openclaw channels status --json
openclaw sessions --all-agents --active 1440 --json
```

Also record:

- current npm package version and install path
- current gateway PID and uptime
- current Telegram session key and token count
- current OpenClaw config backup path

Do not print secrets in deployment notes.

## Rollout

Recommended rollout order:

1. Stop the local test gateway, if any.
2. Install the candidate package into a temporary or isolated Node prefix when possible.
3. Run `openclaw --version` and a CLI smoke test from the candidate install.
4. Start a test gateway with Telegram disabled or with a non-production account.
5. Verify the gateway starts, probes, and stops cleanly.
6. Only then consider replacing the production package.

For a production Telegram account, the first live verification should be a short
message such as `/status` or a one-line prompt. Do not paste long logs into the first
test message.

## Rollback

Rollback must be simple and pre-decided:

1. Stop the candidate gateway.
2. Reinstall the previous known-good OpenClaw npm version or restore the previous
   package directory.
3. Restore the previous gateway service command if it was changed.
4. Start the gateway.
5. Verify `openclaw gateway probe --json` and `openclaw channels status --json`.

The reliability inflight store is safe to leave in place during rollback. It is
state-only telemetry and should not be required by the previous version.

## Expected User-Facing Changes

Users should see fewer silent Telegram failures:

- A timeout should produce a short timeout notice.
- A high-context long input should produce a handoff/new-session suggestion.
- A gateway restart should produce an interrupted-request notice after Telegram
  runtime startup.
- `/new` should remain available as a true fresh-start command; handoff context is
  loaded only after an explicit `/resume latest`.

Users should not see automatic duplicate task execution.
