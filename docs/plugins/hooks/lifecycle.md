---
summary: "Plugin install checks, Gateway start and stop, and Gateway-owned cron events"
read_when:
  - You are inspecting staged install material from a plugin runtime
  - You are starting or stopping plugin-owned services with the Gateway
  - You are projecting OpenClaw cron wakes into an external host scheduler
title: "Gateway and install lifecycle hooks"
sidebarTitle: "Lifecycle"
---

Install-time checks, Gateway service lifecycle, and safe external cron
projection. Part of the [Plugin hooks](/plugins/hooks) guide.

## Install hooks

Use `security.installPolicy` for operator-owned allow/warn/block decisions. That
policy runs from OpenClaw config, covers CLI install and update paths, and
fails closed when enabled but unavailable.

`before_install` is a plugin-runtime lifecycle hook. It can run after
`security.installPolicy` in a process where plugin hooks have already been
loaded, such as Gateway-backed install flows. Trusted official and bundled
install paths can skip this hook; they still run the operator install policy.
It is useful for plugin-owned observations, warnings, and compatibility checks,
but it is not the primary enterprise or host security boundary for installs. The
`builtinScan` field remains in the event payload for compatibility, but
OpenClaw no longer runs built-in install-time dangerous-code blocking, so it
is an empty `ok` result. Return additional findings or
`{ block: true, blockReason }` to stop the install in that process.

`block: true` is terminal. `block: false` is treated as no decision. Handler
failures block the install fail-closed.

## Gateway lifecycle

Use `gateway_start` to start general plugin services and `gateway_stop` to
clean up long-running resources. The cron scheduler can still be loading when
`gateway_start` runs, so do not use it as the baseline signal for an external
cron projection.

The legacy `api.on("deactivate", ...)` alias was removed in August 2026. Use
`gateway_stop` for cleanup; see the
[migration note](/plugins/sdk-migration#deactivate-hook-alias).

Do not rely on the internal `gateway:startup` hook for plugin-owned runtime
services.

`cron_reconciled` fires after the Gateway cron scheduler and its on-exit
watchers have reconciled their durable state. It fires for both initial
startup and scheduler replacement during config reload. The event reports
`reason` (`startup` or `reload`) and the effective `enabled` state. Disabled
cron still emits with `enabled: false`, allowing an external projection to
clear stale wakes. Use `ctx.getCron?.()` for the exact scheduler instance that
completed reconciliation; a later reload does not retarget that callback.
`ctx.abortSignal` owns that same scheduler snapshot. The Gateway aborts it as
soon as a newer scheduler is armed or shutdown starts. Pass it through every
durable side effect and do not accept the snapshot after it aborts.
This is a scheduler lifecycle signal, not a plugin-activation signal: a
plugin-only hot reload does not replay it. A newly enabled consumer receives
its first baseline on the next scheduler replacement or Gateway start.

Like other observation hooks, `gateway_start` and `cron_reconciled` callbacks
can overlap. If both handlers share plugin initialization, coordinate them
with a plugin-local readiness promise rather than depending on callback order.

`cron_changed` fires for Gateway-owned cron lifecycle events with a typed
event payload covering `added`, `updated`, `removed`, `started`, `finished`,
and `scheduled` reasons. The event can include a `PluginHookGatewayCronJob`
snapshot (including `state.nextRunAtMs`, `state.lastRunStatus`, and
`state.lastError` when present) plus an optional `PluginHookGatewayCronDeliveryStatus`
of `not-requested` | `delivered` | `not-delivered` | `unknown`. Removed events
are post-commit: they fire only after durable deletion succeeds and still carry
the deleted job snapshot so external schedulers can reconcile state.

A `scheduled` event is post-commit: it fires only after a successful durable
write changes an existing job's effective `nextRunAtMs`, excluding that job's
explicit `added`, `updated`, or `removed` lifecycle event. The top-level
`event.nextRunAtMs` is the committed next wake; when it is absent, the job has
no next wake. Treat these events as reconciliation hints, not an ordered delta
log. Use them as coalescible hints to reread the scheduler last captured by
`cron_reconciled`; do not adopt the scheduler from a `cron_changed` context.
Keep OpenClaw as the source of truth for due checks and execution.

### Safe external cron projection

Project a complete wake snapshot instead of forwarding cron event deltas. The
external adapter's `replaceAll` operation must be atomic and idempotent, and it
must resolve only after the host has durably accepted the snapshot. It must
also honor the supplied abort signal: if the signal aborts before durable
acceptance, the adapter must not accept that snapshot.

This pattern keeps one latest-state worker in flight. Only `cron_reconciled`
adopts a scheduler instance; `cron_changed` merely asks that worker to reread
the authoritative instance, so a late hint cannot restore an older scheduler.
A newer revision aborts the active host attempt before it can accept a stale
snapshot.

```typescript
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type ExternalWake = { jobId: string; runAtMs: number };

type ExternalWakeHost = {
  replaceAll(wakes: readonly ExternalWake[], options: { signal: AbortSignal }): Promise<void>;
  close(): Promise<void>;
};

type CronReader = {
  list(options: { includeDisabled: true }): Promise<
    Array<{
      id: string;
      enabled?: boolean;
      state?: { nextRunAtMs?: number };
    }>
  >;
};

export function registerCronProjection(api: OpenClawPluginApi, host: ExternalWakeHost) {
  const lifecycle = new AbortController();
  let cron: CronReader | undefined;
  let enabled = false;
  let hasBaseline = false;
  let reconciliationSignal: AbortSignal | undefined;
  let requestedRevision = 0;
  let appliedRevision = 0;
  let worker = Promise.resolve();
  let activeAttempt: AbortController | undefined;

  const projectLatest = async () => {
    let retryMs = 1_000;

    while (!lifecycle.signal.aborted && appliedRevision < requestedRevision) {
      const ownerSignal = reconciliationSignal;
      if (!ownerSignal || ownerSignal.aborted) {
        return;
      }
      const targetRevision = requestedRevision;
      const attempt = new AbortController();
      const signal = AbortSignal.any([lifecycle.signal, ownerSignal, attempt.signal]);
      activeAttempt = attempt;

      try {
        const jobs = enabled && cron ? await cron.list({ includeDisabled: true }) : [];
        if (signal.aborted || targetRevision !== requestedRevision) {
          continue;
        }
        const wakes = jobs
          .flatMap((job): ExternalWake[] => {
            const runAtMs = job.enabled === false ? undefined : job.state?.nextRunAtMs;
            return runAtMs === undefined ? [] : [{ jobId: job.id, runAtMs }];
          })
          .sort((a, b) => a.runAtMs - b.runAtMs || a.jobId.localeCompare(b.jobId));

        await host.replaceAll(wakes, { signal });
        if (signal.aborted || targetRevision !== requestedRevision) {
          continue;
        }
        appliedRevision = targetRevision;
        retryMs = 1_000;
      } catch {
        if (lifecycle.signal.aborted || ownerSignal.aborted) {
          return;
        }
        if (attempt.signal.aborted) {
          continue;
        }
        api.logger.warn(`external cron projection failed; retrying in ${retryMs}ms`);
        try {
          await sleep(retryMs, undefined, { signal });
        } catch {
          if (lifecycle.signal.aborted) {
            return;
          }
          if (attempt.signal.aborted) {
            continue;
          }
        }
        retryMs = Math.min(retryMs * 2, 30_000);
      } finally {
        if (activeAttempt === attempt) {
          activeAttempt = undefined;
        }
      }
    }
  };

  const requestProjection = () => {
    const targetRevision = ++requestedRevision;
    activeAttempt?.abort();
    worker = worker.then(async () => {
      if (!lifecycle.signal.aborted && appliedRevision < targetRevision) {
        await projectLatest();
      }
    });
    return worker;
  };

  api.on("cron_reconciled", (event, ctx) => {
    const reconciledCron = ctx.getCron?.();
    if (event.enabled && !reconciledCron) {
      api.logger.warn("cron reconciliation did not expose a scheduler");
      return;
    }
    cron = reconciledCron;
    enabled = event.enabled;
    hasBaseline = true;
    reconciliationSignal = ctx.abortSignal;
    return requestProjection();
  });

  api.on("cron_changed", () => {
    if (hasBaseline) {
      return requestProjection();
    }
  });

  api.on("gateway_stop", async () => {
    lifecycle.abort();
    await worker;
    await host.close();
  });
}
```

When `cron_reconciled` reports `enabled: false`, the same path calls
`replaceAll([])` and clears stale external wakes. Retry/backoff in this example
is process-local and treats runtime adapter failures as transient; validate
non-retryable configuration before registration. OpenClaw does not provide an
outbox for plugin hook effects. If the process exits before durable acceptance,
the next Gateway start emits a new authoritative `cron_reconciled` snapshot.
`gateway_stop` aborts in-flight host work, waits for the worker to settle, then
closes the adapter.
