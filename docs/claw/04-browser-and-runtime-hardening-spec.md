---
title: "Claw v1 Browser and Runtime Hardening Spec"
summary: "Required Windows browser/runtime fixes before browser-dependent Claw autonomy is supported."
read_when:
  - You are fixing browser startup, attach, or restart behavior.
  - You need the exact timeout budgets for Claw v1 browser stability.
  - You are changing gateway restart behavior on Windows.
status: active
---

# Claw v1 Browser and Runtime Hardening Spec

## Purpose

Claw cannot depend on browser automation until the browser runtime is stable enough for multi-step autonomous work on Windows. This spec defines the minimum hardening required before browser-dependent missions are considered supported.

The implementation target is source-level code, not ad-hoc patching of installed `dist` files.

## Problem statement

Current OpenClaw browser behavior is limited by a mix of short startup budgets, short probe windows, weak abort propagation, and a Unix-oriented restart path that is unreliable on Windows.

The practical failure modes include:

- browser startup timing out too early
- status probes declaring failure before the browser is actually ready
- `/start` timing out while Chrome continues launching in the background
- error messages implying permanent failure when the real issue is startup timing
- `SIGUSR1`-style restart behavior that is not appropriate on Windows

## Required outcome

After hardening, the browser runtime must support:

- reliable `status`
- reliable `start`
- reliable attach after cold launch
- multi-step interactive browser flows
- restart without needing manual recovery gymnastics

## Timeout budgets

Claw v1 adopts these minimum browser budgets.

### Client-facing tool budgets

- `browserStatus`: `5000ms`
- `browserStart`: `45000ms`
- `browserStop`: `45000ms`

### CDP and reachability budgets

- `CDP_HTTP_REQUEST_TIMEOUT_MS = 5000`
- `CDP_WS_HANDSHAKE_TIMEOUT_MS = 10000`
- `CDP_JSON_NEW_TIMEOUT_MS = 5000`
- `CHROME_REACHABILITY_TIMEOUT_MS = 1000`
- `CHROME_WS_READY_TIMEOUT_MS = 2000`
- `CHROME_LAUNCH_READY_WINDOW_MS = 45000`
- `PROFILE_HTTP_REACHABILITY_TIMEOUT_MS = 1000`
- `PROFILE_WS_REACHABILITY_MIN_TIMEOUT_MS = 1000`
- `PROFILE_WS_REACHABILITY_MAX_TIMEOUT_MS = 5000`
- `PROFILE_ATTACH_RETRY_TIMEOUT_MS = 5000`
- `PROFILE_POST_RESTART_WS_TIMEOUT_MS = 3000`
- `CHROME_MCP_ATTACH_READY_WINDOW_MS = 15000`
- `CDP_READY_AFTER_LAUNCH_WINDOW_MS = 15000`

### Remote defaults

- remote HTTP probe timeout default: `5000`
- remote WS handshake timeout default: `10000`

## Source touchpoints

Primary source files:

- `extensions/browser/src/browser/client.ts`
- `extensions/browser/src/browser/cdp-timeouts.ts`
- `extensions/browser/src/browser/server-context.constants.ts`
- `extensions/browser/src/browser/server-context.availability.ts`
- `extensions/browser/src/browser/config.ts`
- `src/infra/restart.ts`

## Required changes

## 1. Longer startup and status budgets

The browser client and runtime must use the new budgets above.

This includes:

- client helper timeouts
- availability/probe helpers
- attach/restart windows
- remote default probe budgets

No lower hardcoded timeout may undermine the budgets above for the same phase.

## 2. Abort-aware startup path

Browser start and availability checks must propagate abort or cancellation cleanly.

Required behavior:

- if the outer caller aborts, the start flow stops waiting and records an aborted startup outcome
- pending background launch state must be reconciled instead of silently drifting
- the next caller must see an honest state rather than a stale timeout artifact

## 3. Honest error reporting

Startup timeout errors must distinguish:

- startup timed out
- attach timed out
- browser is unreachable
- browser may still be launching

The error layer must stop using dramatic but misleading "cannot reach browser" language for startup budget failures.

## 4. Windows-safe restart behavior

Gateway restart must not depend on `SIGUSR1` semantics on Windows.

Required behavior on Windows:

- prefer service-native or task-native restart path when available
- otherwise use a Windows-safe relaunch path
- never depend on Unix signal assumptions as the primary restart contract

## Acceptance bar

Browser runtime is considered hardened only when all of the following are true:

- repeated `status` checks reliably show a ready browser after startup
- repeated `start` calls no longer fail from premature timeout on cold start
- attach works after restart without frequent false negatives
- interactive flows such as login or setup can survive more than one browser action
- gateway restart no longer requires manual SIGUSR1-style recovery on Windows

## Out of scope

This spec does not define new browser capabilities. It only hardens existing browser runtime behavior to the point where Claw can safely rely on it.

## Related specs

- [Full Access Semantics Spec](/claw/01-full-access-semantics-spec)
- [Mission Engine Spec](/claw/02-mission-engine-spec)
- [Test and Acceptance Spec](/claw/07-test-and-acceptance-spec)
