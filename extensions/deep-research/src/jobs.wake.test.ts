import assert from "node:assert/strict";
import type { PluginServiceSessionWorkV1 } from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginServiceScheduler,
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResearchState, ResearchStartRejectedError } from "./job-state.js";
import type { ResearchJob } from "./jobs.js";
import { createResearchJobsFixture, descriptor, handle, completed } from "./jobs.test-support.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close();
  }
});
const fixture = (options: Parameters<typeof createResearchJobsFixture>[0] = {}) =>
  createResearchJobsFixture(options, (close) => cleanup.push(close));

describe("durable research wakes", () => {
  it("classifies admission denials as rejected before any durable job or wake", async () => {
    const sessionWork: Omit<PluginServiceSessionWorkV1, "withCurrent"> = {
      version: 1,
      admit: async () => {
        throw new Error("Web tools denied by policy");
      },
      run: vi.fn(),
    };
    const { jobs, context, runtime, readStore } = await fixture({ sessionWork });
    await expect(
      jobs.start({ question: "Policy denied" }, "policy-key", context, undefined, undefined, true),
    ).rejects.toBeInstanceOf(ResearchStartRejectedError);
    expect(await readStore().count()).toBe(0);
    expect(
      await runtime.state
        .openKeyedStoreV2({
          namespace: "research-wakes-v1",
          maxEntries: 4096,
          overflowPolicy: "reject-new",
        })
        .count(),
    ).toBe(0);
    expect(sessionWork.run).not.toHaveBeenCalled();
  });
  it.each(["unavailable", "missing", "terminal", "deferred"] as const)(
    "retires an obsolete wake without provider effects: %s",
    async (condition) => {
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
      const sessionWork: Omit<PluginServiceSessionWorkV1, "withCurrent"> = {
        version: 1,
        admit: async () => ({
          recoverable: true,
          target: {
            agentId: "main",
            sessionKey: "agent:main:research-fixture",
            sessionId: "generation-1",
          },
        }),
        run: async () => ({ status: "unavailable", reason: "Source revoked" }),
      };
      const { jobs, runtime, context, readStore } = await fixture({ scheduler, sessionWork });
      const running = { version: 1, ok: true, value: { state: "running", handle, citations: [] } };
      const request = vi
        .mocked(runtime.gateway.request)
        .mockResolvedValueOnce(descriptor)
        .mockResolvedValueOnce(running)
        .mockImplementation(async () => {
          clock.setTime(clock.clock.now() + 2);
          return running;
        });
      const job = await jobs.start(
        { question: "A retained research job", engine: "google" },
        "obsolete-wake",
        context,
      );
      const wakes = runtime.state.openKeyedStoreV2({
        namespace: "research-wakes-v1",
        maxEntries: 4096,
        overflowPolicy: "reject-new",
      });
      expect(await wakes.count()).toBe(1);
      if (condition === "missing") {
        await readStore().delete(job.id);
      } else if (condition !== "unavailable") {
        await readStore().register(job.id, {
          ...job,
          ...(condition === "terminal"
            ? { state: "completed" as const }
            : { recovery: "deferred" as const }),
        });
      }
      await clock.advanceBy(6000);
      expect(await wakes.count()).toBe(0);
      if (condition === "unavailable") {
        expect(await readStore().lookup(job.id)).toMatchObject({
          state: "paused",
          recovery: "deferred",
        });
      }
      await jobs.startRecovery();
      await clock.advanceBy(60_000);
      expect(request).toHaveBeenCalledTimes(3);
    },
  );

  it.each(
    ["start", "describe"].flatMap((action) => [1, 5].map((failures) => ({ action, failures }))),
  )(
    "retries a never-sent router refusal with persisted backoff: $action/$failures",
    async ({ action, failures }) => {
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
      const target = {
        agentId: "main",
        sessionKey: "agent:main:research-fixture",
        sessionId: "generation-1",
      };
      const sessionWork: Omit<PluginServiceSessionWorkV1, "withCurrent"> = {
        version: 1,
        admit: async () => ({ recoverable: true, target }),
        run: async (_id, work) => ({
          status: "completed",
          value: await work({
            target,
            signal: scheduler.signal,
            assertCurrent: () => scheduler.signal.throwIfAborted(),
          }),
        }),
      };
      const { jobs, runtime, context, readStore } = await fixture({ scheduler, sessionWork });
      let attempts = 0;
      let submissions = 0;
      vi.mocked(runtime.gateway.request).mockImplementation(async (_method, params) => {
        assert.ok(params);
        const request = params.request as { action: string };
        if (request.action === action && ++attempts <= failures) {
          throw Object.assign(new Error("Gateway preparation is temporarily unavailable"), {
            name: "GatewayClientRequestError",
            gatewayCode: "UNAVAILABLE",
            retryable: true,
            details:
              action === "describe"
                ? { reason: "startup-sidecars" }
                : { code: "SESSION_ACCESS_REFRESHING" },
          });
        }
        if (request.action === "describe") {
          return descriptor;
        }
        expect(request.action).toBe("start");
        submissions++;
        return completed;
      });
      const first = await jobs.start(
        { question: "Unsent river report", engine: "google" },
        "router-refresh",
        context,
      );
      for (let failure = 1; failure <= failures; failure++) {
        const job = await readStore().lookup(first.id);
        assert.ok(job);
        expect(job.state).toBe("paused");
        expect(job.recovery).toBe(failure === 5 ? "deferred" : "ready");
        expect(attempts).toBe(failure);
        expect(submissions).toBe(0);
        if (failure < 5) {
          assert.ok(job.nextWakeAt);
          expect(job.nextWakeAt - clock.clock.now()).toBeGreaterThanOrEqual(
            5000 * 2 ** (failure - 1),
          );
          await jobs.startRecovery();
          await clock.advanceBy(1000);
          expect(attempts).toBe(failure);
          await clock.advanceBy(job.nextWakeAt - clock.clock.now());
        }
      }
      if (failures === 1) {
        expect((await readStore().lookup(first.id))?.state).toBe("completed");
        expect(attempts).toBe(2);
        expect(submissions).toBe(1);
      } else {
        await jobs.startRecovery();
        await clock.advanceBy(600_000);
        expect(attempts).toBe(5);
        expect(submissions).toBe(0);
      }
    },
  );

  it("does not prune a wake when its job renews between observation and deletion", async () => {
    const { api, scheduler, context } = await fixture();
    const state = new ResearchState(api, scheduler);
    const jobs = state.open<ResearchJob>("jobs", context);
    const wakes = state.wakes();
    const job: ResearchJob = {
      version: 1,
      id: "prune-race",
      request: { question: "A concurrent wake" },
      agentId: context.agentId,
      sessionKey: context.sessionKey,
      sessionId: context.sessionId,
      createdAt: scheduler.now(),
      deadlineAt: 0,
      state: "paused",
      recovery: "deferred",
      progress: "Deferred",
    };
    await jobs.register(job.id, job);
    await wakes.register(job.id, {
      id: job.id,
      agentId: job.agentId,
      sessionKey: job.sessionKey,
      sessionId: job.sessionId,
      nextWakeAt: scheduler.now(),
    });
    const compare = wakes.compareAndApply;
    const mutation = vi.spyOn(wakes, "compareAndApply").mockImplementation(async (...args) => {
      // Interleave a real producer write after cleanup prepared both observations,
      // before its native atomic deletion. The wake itself stays unchanged.
      await jobs.register(job.id, {
        ...job,
        recovery: "ready",
        nextWakeAt: scheduler.now() + 60_000,
      });
      return compare(...args);
    });
    vi.spyOn(state, "wakes").mockReturnValue(wakes);
    await state.pruneWake(job.id);
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(await wakes.count()).toBe(1);
    expect(await jobs.lookup(job.id)).toMatchObject({ recovery: "ready" });
  });

  it.each([false, true, "router"] as const)(
    "bounds automatic poll failures across wakes (retryable=%s)",
    async (retryable) => {
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
      const target = {
        agentId: "main",
        sessionKey: "agent:main:research-fixture",
        sessionId: "generation-1",
      };
      const sessionWork: Omit<PluginServiceSessionWorkV1, "withCurrent"> = {
        version: 1,
        admit: async () => ({ recoverable: true, target }),
        run: async (_id, work) => ({
          status: "completed",
          value: await work({
            target,
            signal: scheduler.signal,
            assertCurrent: () => scheduler.signal.throwIfAborted(),
          }),
        }),
      };
      const { jobs, runtime, context, readStore } = await fixture({ scheduler, sessionWork });
      let submissions = 0;
      const polls: number[] = [];
      vi.mocked(runtime.gateway.request).mockImplementation(async (_method, params) => {
        assert.ok(params);
        const request = params.request as { action: string };
        if (request.action === "describe") {
          return descriptor;
        }
        if (request.action === "start") {
          submissions += 1;
          return { version: 1, ok: true, value: { state: "running", handle, citations: [] } };
        }
        expect(request.action).toBe("poll");
        polls.push(clock.clock.now());
        clock.setTime(clock.clock.now() + 2);
        if (retryable === "router") {
          throw Object.assign(new Error("Session access is refreshing"), {
            name: "GatewayClientRequestError",
            gatewayCode: "UNAVAILABLE",
            retryable: true,
            details: { code: "SESSION_ACCESS_REFRESHING" },
          });
        }
        return {
          version: 1,
          ok: false,
          state: "indeterminate",
          handle,
          reason: `Google research poll returned HTTP ${retryable ? 503 : 404}.`,
          ...(retryable ? { retryAfterMs: 5000 } : {}),
        };
      });
      const initial = await jobs.start(
        { question: "A retained failing job", engine: "google" },
        "failed-poll",
        context,
      );
      const limit = retryable ? 5 : 1;
      for (let failure = 1; failure < limit; failure++) {
        const current = await readStore().lookup(initial.id);
        assert.ok(current?.nextWakeAt);
        expect(current.nextWakeAt - clock.clock.now()).toBeGreaterThanOrEqual(
          5000 * 2 ** (failure - 1),
        );
        await clock.advanceBy(current.nextWakeAt - clock.clock.now());
      }
      expect(await readStore().lookup(initial.id)).toMatchObject({
        state: "paused",
        recovery: "deferred",
        handle,
      });
      expect(submissions).toBe(1);
      expect(polls).toHaveLength(limit);
      for (let index = 1; index < polls.length; index++) {
        expect(polls[index]! - polls[index - 1]!).toBeGreaterThanOrEqual(5000 * 2 ** (index - 1));
      }
      await jobs.startRecovery();
      await clock.advanceBy(600_000);
      expect(polls).toHaveLength(limit);
      expect(submissions).toBe(1);
    },
  );

  it.each([
    { failures: 1, thrown: false },
    { failures: 5, thrown: false },
    { failures: 1, thrown: true },
    { failures: 5, thrown: true },
  ])(
    "reacquires temporarily unavailable authority with a persisted limit: $failures (thrown=$thrown)",
    async ({ failures, thrown }) => {
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
      const target = {
        agentId: "main",
        sessionKey: "agent:main:research-fixture",
        sessionId: "generation-1",
      };
      let attempts = 0;
      const sessionWork: Omit<PluginServiceSessionWorkV1, "withCurrent"> = {
        version: 1,
        admit: async () => ({ recoverable: true, target }),
        run: async (_id, work) => {
          if (++attempts <= failures) {
            if (thrown) {
              throw new Error("Current Gateway context or transport is temporarily unavailable");
            }
            return {
              status: "unavailable",
              reason: "Session access is refreshing",
              retryAfterMs: 5000,
            };
          }
          return {
            status: "completed",
            value: await work({
              target,
              signal: scheduler.signal,
              assertCurrent: () => scheduler.signal.throwIfAborted(),
            }),
          };
        },
      };
      const { jobs, runtime, context, readStore } = await fixture({ scheduler, sessionWork });
      const running = { version: 1, ok: true, value: { state: "running", handle, citations: [] } };
      const request = vi
        .mocked(runtime.gateway.request)
        .mockResolvedValueOnce(descriptor)
        .mockResolvedValueOnce(running)
        .mockImplementationOnce(async () => {
          clock.setTime(clock.clock.now() + 2);
          return running;
        })
        .mockResolvedValue(completed);
      const first = await jobs.start(
        { question: "Transient authority report", engine: "google" },
        "refresh",
        context,
      );
      for (let failure = 0; failure < failures; failure++) {
        const job = await readStore().lookup(first.id);
        assert.ok(job?.nextWakeAt);
        await clock.advanceBy(job.nextWakeAt - clock.clock.now());
        expect(attempts).toBe(failure + 1);
        const paused = await readStore().lookup(first.id);
        assert.ok(paused);
        expect(paused.recovery).toBe(failure === 4 ? "deferred" : "ready");
        if (failure < 4) {
          expect(paused.nextWakeAt! - clock.clock.now()).toBeGreaterThanOrEqual(
            5000 * 2 ** failure,
          );
        }
        // Repeated startup scans must not bypass the authoritative persisted backoff.
        await jobs.startRecovery();
        await clock.advanceBy(1000);
        expect(attempts).toBe(failure + 1);
      }
      const latest = await readStore().lookup(first.id);
      assert.ok(latest);
      if (failures === 1) {
        await clock.advanceBy(latest.nextWakeAt! - clock.clock.now());
        expect((await readStore().lookup(first.id))?.state).toBe("completed");
        expect(request).toHaveBeenCalledTimes(4);
      } else {
        await clock.advanceBy(600_000);
        expect(attempts).toBe(5);
        expect(request).toHaveBeenCalledTimes(3);
      }
    },
  );

  it.each(["foreground", "recovered"] as const)(
    "does not poll the recovery index while a %s job owns its slot",
    async (mode) => {
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
      const occupied = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const scheduling = vi.spyOn(scheduler, "schedule");
      const target = {
        agentId: "main",
        sessionKey: "agent:main:research-fixture",
        sessionId: "generation-1",
      };
      const sessionWork: Omit<PluginServiceSessionWorkV1, "withCurrent"> = {
        version: 1,
        admit: async () => ({ recoverable: true, target }),
        run: async (_id, work) => ({
          status: "completed",
          value: await work({
            target,
            signal: scheduler.signal,
            assertCurrent: () => scheduler.signal.throwIfAborted(),
          }),
        }),
      };
      const run = vi.spyOn(sessionWork, "run");
      const { jobs, runtime, context, readStore } = await fixture({ scheduler, sessionWork });
      let submissions = 0;
      let pauseFirst = mode === "recovered";
      vi.mocked(runtime.gateway.request).mockImplementation(async (_method, params) => {
        assert.ok(params);
        const request = params.request as { action: string };
        if (request.action === "describe") {
          return descriptor;
        }
        if (request.action === "start") {
          submissions++;
          return { version: 1, ok: true, value: { state: "running", handle, citations: [] } };
        }
        expect(request.action).toBe("poll");
        if (pauseFirst) {
          pauseFirst = false;
          return { version: 1, ok: true, value: { state: "running", handle, citations: [] } };
        }
        occupied.resolve();
        await release.promise;
        return completed;
      });
      const starting = jobs.start(
        {
          question: "A held river report",
          engine: "google",
        },
        `held-${mode}`,
        context,
      );
      let waking: Promise<void> | undefined;
      let first: ResearchJob | undefined;
      try {
        if (mode === "recovered") {
          first = await starting;
          expect(first.state).toBe("paused");
          waking = Promise.resolve(clock.advanceBy(6000));
        }
        await Promise.race([
          occupied.promise,
          (waking ?? starting).then(() => {
            throw new Error("Research ended before the provider poll was held");
          }),
        ]);
        scheduling.mockClear();
        const stores = vi.spyOn(runtime.state, "openKeyedStoreV2");
        // The clock does not replay missed ticks. Drive each possible one-second
        // wake explicitly while the real job owner remains inside provider work.
        for (let tick = 0; tick < 60; tick++) {
          await clock.advanceBy(1000);
        }
        expect(
          scheduling.mock.calls.filter(([entry]) => entry.id.startsWith("research-wake:")),
        ).toHaveLength(0);
        expect(stores).not.toHaveBeenCalled();
        expect(run).toHaveBeenCalledTimes(mode === "recovered" ? 1 : 0);
        release.resolve();
        const finished = await starting;
        await waking;
        expect((await readStore().lookup((first ?? finished).id))?.state).toBe("completed");
        expect(submissions).toBe(1);
      } finally {
        release.resolve();
        await Promise.allSettled([starting, waking]);
      }
    },
  );

  it.each(["jobs", "steps"] as const)(
    "releases the slot when native %s store opening observes an aborted invocation",
    async (kind) => {
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
      const parent = new AbortController();
      const target = {
        agentId: "main",
        sessionKey: "agent:main:research-fixture",
        sessionId: "generation-1",
      };
      let armed = false;
      let abortedAt: string | undefined;
      const sessionWork: Omit<PluginServiceSessionWorkV1, "withCurrent"> = {
        version: 1,
        admit: async () => {
          armed = true;
          return { recoverable: true, target };
        },
        run: async (_id, work) => ({
          status: "completed",
          value: await work({
            target,
            signal: scheduler.signal,
            assertCurrent: () => scheduler.signal.throwIfAborted(),
          }),
        }),
      };
      const { jobs, runtime, context, readStore } = await fixture({ scheduler, sessionWork });
      const open = runtime.state.openKeyedStoreV2;
      runtime.state.openKeyedStoreV2 = <T>(
        options: Parameters<typeof open>[0],
        authority: Parameters<typeof open>[1],
      ) => {
        if (armed && options.namespace.startsWith(`research-${kind}-v1-`)) {
          armed = false;
          abortedAt = kind;
          parent.abort(new Error("Invocation stopped at store open"));
        }
        // Exercise the native store constructor's synchronous authority fence.
        return open<T>(options, authority);
      };
      const request = vi
        .mocked(runtime.gateway.request)
        .mockResolvedValueOnce(descriptor)
        .mockResolvedValueOnce(completed);
      await expect(
        jobs.start(
          { question: "An accepted river report", engine: "google" },
          `slot-open-${kind}`,
          context,
          parent.signal,
        ),
      ).rejects.toThrow("Invocation stopped at store open");
      expect(abortedAt).toBe(kind);
      const rows = await readStore().entries();
      expect(rows).toHaveLength(1);
      const retained = rows[0]!.value;
      expect(retained).toMatchObject({ state: "queued", recovery: "ready" });
      expect(retained.result).toBeUndefined();
      expect(request).not.toHaveBeenCalled();
      await clock.advanceBy(1000);
      expect((await readStore().lookup(retained.id))?.state).toBe("completed");
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("reschedules a wake when capacity fills during admission", async () => {
    const clock = createGatewaySchedulerClock(Date.now());
    const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
    const admitted = Promise.withResolvers<void>();
    const releaseAdmission = Promise.withResolvers<void>();
    const occupied = Promise.withResolvers<void>();
    const releaseBusy = Promise.withResolvers<void>();
    const target = {
      agentId: "main",
      sessionKey: "agent:main:research-fixture",
      sessionId: "generation-1",
    };
    let primaryId = "";
    let holdAdmission = true;
    // Isolate the slot invariant at the production scheduler/job owner. Real
    // host reauthorization and HTTP/publication are covered by the Gateway fixture.
    const sessionWork: Omit<PluginServiceSessionWorkV1, "withCurrent"> = {
      version: 1,
      admit: async () => ({ recoverable: true, target }),
      run: async (id, work) => {
        if (id === primaryId && holdAdmission) {
          holdAdmission = false;
          admitted.resolve();
          await releaseAdmission.promise;
        }
        return {
          status: "completed",
          value: await work({
            target,
            signal: scheduler.signal,
            assertCurrent: () => scheduler.signal.throwIfAborted(),
          }),
        };
      },
    };
    const { jobs, runtime, context } = await fixture({ scheduler, sessionWork });
    let submissions = 0;
    let busyPolls = 0;
    let recovery = false;
    vi.mocked(runtime.gateway.request).mockImplementation(async (_method, params) => {
      assert.ok(params);
      const request = params.request as { action: string; handle?: typeof handle };
      if (request.action === "describe") {
        return descriptor;
      }
      if (request.action === "start") {
        submissions += 1;
        return {
          version: 1,
          ok: true,
          value: {
            state: "running",
            handle: { ...handle, interactionId: `slot-${submissions}` },
            citations: [],
          },
        };
      }
      assert.ok(request.handle);
      if (request.handle.interactionId === "slot-1" && !recovery) {
        clock.setTime(clock.clock.now() + 2);
        return {
          version: 1,
          ok: true,
          value: { state: "running", handle: request.handle, citations: [] },
        };
      }
      if (request.handle.interactionId !== "slot-1") {
        if (++busyPolls === 4) {
          occupied.resolve();
        }
        await releaseBusy.promise;
      }
      return { ...completed, value: { ...completed.value, handle: request.handle } };
    });
    const first = await jobs.start(
      { question: "Primary river report", engine: "google" },
      "primary-slot",
      context,
    );
    primaryId = first.id;
    expect(first.state).toBe("paused");
    recovery = true;
    const waking = Promise.resolve(clock.advanceBy(6000));
    const busy: Array<Promise<ResearchJob>> = [];
    try {
      await Promise.race([
        admitted.promise,
        waking.then(() => {
          throw new Error("Wake ended before source admission");
        }),
      ]);
      for (let index = 0; index < 4; index++) {
        busy.push(
          jobs.start(
            { question: `Busy river report ${index}`, engine: "google" },
            `busy-slot-${index}`,
            context,
          ),
        );
      }
      await Promise.race([
        occupied.promise,
        Promise.all(busy).then(() => {
          throw new Error("Competing work ended before filling the slots");
        }),
      ]);
      releaseAdmission.resolve();
      await waking;
      expect(submissions).toBe(5);
      const scheduling = vi.spyOn(scheduler, "schedule");
      for (let tick = 0; tick < 60; tick++) {
        await clock.advanceBy(1000);
      }
      expect(
        scheduling.mock.calls.filter(([entry]) => entry.id.startsWith("research-wake:")),
      ).toHaveLength(0);
      releaseBusy.resolve();
      await Promise.all(busy);
      await clock.advanceBy(6000);
      expect((await jobs.get(primaryId, context)).state).toBe("completed");
      expect(submissions).toBe(5);
    } finally {
      releaseAdmission.resolve();
      releaseBusy.resolve();
      await Promise.allSettled([waking, ...busy]);
    }
  });
});

it("accepts duplicate UI starts without invoking a model in the request, survives restart, and keeps reads pure", async () => {
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  const target = {
    agentId: "main",
    sessionKey: "agent:main:research-fixture",
    sessionId: "generation-1",
  };
  const sessionWork: Omit<PluginServiceSessionWorkV1, "withCurrent"> = {
    version: 1,
    admit: async () => ({ recoverable: true, target }),
    run: async (_id, work) => ({
      status: "completed",
      value: await work({ target, signal: scheduler.signal, assertCurrent() {} }),
    }),
  };
  const { jobs, context, runtime, readStore } = await fixture({ scheduler, sessionWork });
  const network = vi
    .mocked(runtime.gateway.request)
    .mockResolvedValueOnce(descriptor)
    .mockResolvedValue(completed);
  const request = { question: "Research UI durable acceptance", engine: "google" as const };
  const starts = await Promise.all([
    jobs.start(request, "ui-retry", context, undefined, undefined, true),
    jobs.start(request, "ui-retry", context, undefined, undefined, true),
  ]);
  expect(starts[0].id).toBe(starts[1].id);
  expect(network).not.toHaveBeenCalled();
  expect(await readStore().count()).toBe(1);
  await jobs.startRecovery();
  await clock.advanceBy(1000);
  expect((await jobs.read(starts[0].id, context)).state).toBe("completed");
  expect(network).toHaveBeenCalledTimes(2);
  const retained = await readStore().lookup(starts[0].id);
  assert.ok(retained);
  await readStore().register(starts[0].id, { ...retained, state: "submitting" });
  const rawBefore = await readStore().lookup(starts[0].id);
  expect((await jobs.read(starts[0].id, context)).state).toBe("submitting");
  expect((await jobs.list(context))[0]?.state).toBe("submitting");
  expect(await readStore().lookup(starts[0].id)).toEqual(rawBefore);
  expect(network).toHaveBeenCalledTimes(2);
  await expect(
    jobs.read(starts[0].id, { ...context, sessionId: "reset-incarnation" }),
  ).rejects.toThrow("not found");
});

it("retains concurrent UI cancellation requests until the service observes termination", async () => {
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  const target = {
    agentId: "main",
    sessionKey: "agent:main:research-fixture",
    sessionId: "generation-1",
  };
  const sessionWork: Omit<PluginServiceSessionWorkV1, "withCurrent"> = {
    version: 1,
    admit: async () => ({ recoverable: true, target }),
    run: async (_id, work) => ({
      status: "completed",
      value: await work({ target, signal: scheduler.signal, assertCurrent() {} }),
    }),
  };
  const { jobs, context, runtime } = await fixture({ scheduler, sessionWork });
  const job = await jobs.start(
    { question: "Cancel before work begins" },
    "ui-cancel",
    context,
    undefined,
    undefined,
    true,
  );
  const cancelled = await Promise.all([
    jobs.cancel(job, context, undefined, true),
    jobs.cancel(job, context, undefined, true),
  ]);
  expect(cancelled.every((value) => value.state === "queued" && value.cancelRequested)).toBe(true);
  expect((await jobs.read(job.id, context)).cancelRequested).toBe(true);
  await clock.advanceBy(1000);
  expect((await jobs.read(job.id, context)).state).toBe("cancelled");
  expect(runtime.llm.complete).not.toHaveBeenCalled();
  expect(runtime.gateway.request).not.toHaveBeenCalled();
});

it("rechecks the borrowed incarnation after an awaited model-tool report lookup", async () => {
  const { tool, runtime, context } = await fixture();
  context.lifecycleRevision = "original";
  const request = vi
    .mocked(runtime.gateway.request)
    .mockResolvedValueOnce(descriptor)
    .mockResolvedValueOnce(completed);
  const result = await tool.execute("start", {
    action: "start",
    idempotencyKey: "stable-request",
    request: { question: "Research the river.", engine: "google" },
  });
  const details = result.details;
  assert.ok(details && typeof details === "object" && "jobId" in details);
  const open = runtime.state.openKeyedStoreV2;
  runtime.state.openKeyedStoreV2 = <T>(...args: Parameters<typeof open<T>>) => {
    const [options, authority] = args;
    const store = open<T>(options, authority);
    if (!options.namespace.startsWith("research-jobs-v1-")) {
      return store;
    }
    return {
      ...store,
      lookup: async (key) => {
        const value = await store.lookup(key);
        context.lifecycleRevision = "replacement";
        return value;
      },
    };
  };
  await expect(
    tool.execute("retired-during-read", { action: "result", jobId: details.jobId }),
  ).rejects.toThrow("Fixture incarnation retired");
  expect(request).toHaveBeenCalledTimes(2);
});
