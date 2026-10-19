import assert from "node:assert/strict";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResearchJobs, type ResearchJob } from "./jobs.js";
import { createResearchJobsFixture, descriptor, handle, completed } from "./jobs.test-support.js";
import { createResearchTool } from "./tool.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close();
  }
});
const fixture = (options: Parameters<typeof createResearchJobsFixture>[0] = {}) =>
  createResearchJobsFixture(options, (close) => cleanup.push(close));

const start = {
  action: "start",
  idempotencyKey: "stable-request",
  request: { question: "Research the river.", engine: "google" },
};

describe("durable research tool", () => {
  it("persists one managed submission/result and returns it idempotently across restart", async () => {
    const { tool, runtime, api, scheduler, context } = await fixture();
    const request = vi
      .mocked(runtime.gateway.request)
      .mockResolvedValueOnce(descriptor)
      .mockResolvedValueOnce(completed);
    const first = await tool.execute("call-1", start);
    expect(first.details).toMatchObject({
      state: "completed",
      result: {
        engine: "managed",
        sources: [],
        providerCitations: [{ url: "https://example.org/source" }],
      },
    });
    const reopened = new ResearchJobs(api, scheduler);
    const again = await createResearchTool(api, context, reopened).execute("call-2", {
      ...start,
      request: { engine: "google", question: "Research the river." },
    });
    expect(again.details).toEqual(first.details);
    expect(request).toHaveBeenCalledTimes(2);
    await expect(
      tool.execute("call-3", {
        ...start,
        request: { ...start.request, question: "A different question" },
      }),
    ).rejects.toThrow("Idempotency key");
  });
  it("retains a returned start handle before an interrupted borrow can discard it", async () => {
    const { jobs, runtime, context, current, readStore } = await fixture();
    const actions: string[] = [];
    vi.mocked(runtime.gateway.request).mockImplementation(async (_method, params) => {
      assert.ok(params);
      const request = params.request as { action: string };
      actions.push(request.action);
      if (request.action === "describe") {
        return descriptor;
      }
      if (request.action === "start") {
        current.mockImplementation(() => {
          throw new Error("Interrupted authority borrow");
        });
      }
      return completed;
    });
    await expect(
      jobs.start({ question: "River", engine: "google" }, "receipt-refresh", context),
    ).rejects.toThrow("Interrupted authority borrow");
    const rows = await readStore().entries();
    expect(rows).toHaveLength(1);
    const retained = rows[0]!.value;
    expect(retained).toMatchObject({ state: "paused", handle });
    expect(retained.result).toBeUndefined();
    expect(retained.publicationId).toBeUndefined();
    current.mockReset();
    expect((await jobs.run(retained, context)).state).toBe("completed");
    expect(actions).toEqual(["describe", "start", "poll"]);
  });

  it("retains a definitive not-sent response when the source closes before delivery", async () => {
    const { jobs, runtime, context, current, readStore } = await fixture();
    const actions: string[] = [];
    vi.mocked(runtime.gateway.request).mockImplementation(async (_method, params) => {
      assert.ok(params);
      const request = params.request as { action: string };
      actions.push(request.action);
      if (request.action === "describe") {
        return descriptor;
      }
      current.mockImplementation(() => {
        throw new Error("Borrow closed before refusal delivery");
      });
      return {
        version: 1,
        ok: false,
        state: "blocked",
        retryAfterMs: 5000,
        reason: "Request was not sent",
      };
    });
    await expect(
      jobs.start({ question: "River", engine: "google" }, "refused-refresh", context),
    ).rejects.toThrow("Borrow closed before refusal delivery");
    const rows = await readStore().entries();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toMatchObject({ state: "paused" });
    expect(rows[0]!.value.handle).toBeUndefined();
    expect(rows[0]!.value.result).toBeUndefined();
    current.mockReset();
    vi.mocked(runtime.gateway.request)
      .mockResolvedValueOnce(descriptor)
      .mockResolvedValueOnce(completed);
    expect((await jobs.run(rows[0]!.value, context)).state).toBe("completed");
    expect(actions).toEqual(["describe", "start"]);
    expect(runtime.gateway.request).toHaveBeenCalledTimes(4);
  });

  it("does not overwrite a newer terminal row when a start receipt returns", async () => {
    const { jobs, runtime, context, readStore } = await fixture();
    let newer: ResearchJob | undefined;
    vi.mocked(runtime.gateway.request).mockImplementation(async (_method, params) => {
      assert.ok(params);
      const request = params.request as { action: string };
      if (request.action === "describe") {
        return descriptor;
      }
      expect(request.action).toBe("start");
      const [pending] = await readStore().entries();
      assert.ok(pending);
      expect(pending.value.state).toBe("submitting");
      newer = { ...pending.value, state: "cancelled", progress: "Newer terminal observation" };
      await readStore().register(pending.key, newer);
      return completed;
    });
    await expect(
      jobs.start({ question: "River", engine: "google" }, "receipt-race", context),
    ).rejects.toThrow("Research receipt no longer belongs to the pending submission");
    expect((await readStore().entries())[0]?.value).toEqual(newer);
    expect(runtime.gateway.request).toHaveBeenCalledTimes(2);
  });

  it("preserves a newer terminal row committed between receipt observation and CAS", async () => {
    const { jobs, runtime, context, readStore } = await fixture();
    const open = runtime.state.openKeyedStoreV2;
    let armed = false;
    let conflicted = false;
    let newer: ResearchJob | undefined;
    runtime.state.openKeyedStoreV2 = <T>(
      options: Parameters<typeof open>[0],
      authority: Parameters<typeof open>[1],
    ) => {
      const store = open<T>(options, authority);
      return {
        ...store,
        compareAndApply: async (...args: Parameters<typeof store.compareAndApply>) => {
          if (armed && options.namespace.startsWith("research-jobs-v1-")) {
            armed = false;
            const pending = await readStore().lookup(args[0]);
            assert.ok(pending);
            expect(pending.state).toBe("submitting");
            newer = { ...pending, state: "cancelled", progress: "Concurrent terminal commit" };
            await readStore().register(args[0], newer);
            const result = await store.compareAndApply(...args);
            conflicted = result.status === "conflict";
            return result;
          }
          return store.compareAndApply(...args);
        },
      };
    };
    vi.mocked(runtime.gateway.request).mockImplementation(async (_method, params) => {
      assert.ok(params);
      const request = params.request as { action: string };
      if (request.action === "describe") {
        return descriptor;
      }
      expect(request.action).toBe("start");
      armed = true;
      return completed;
    });
    await expect(
      jobs.start({ question: "River", engine: "google" }, "receipt-cas-race", context),
    ).rejects.toThrow("Research receipt raced with newer job state");
    expect(conflicted).toBe(true);
    expect((await readStore().entries())[0]?.value).toEqual(newer);
    expect(runtime.gateway.request).toHaveBeenCalledTimes(2);
  });

  it("does not resubmit an ambiguous start and rejects unsupported native constraints before effects", async () => {
    const { tool, runtime } = await fixture();
    const request = vi
      .mocked(runtime.gateway.request)
      .mockResolvedValueOnce(descriptor)
      .mockResolvedValueOnce({
        version: 1,
        ok: false,
        state: "indeterminate",
        reason: "Response lost after submission.",
      });
    expect((await tool.execute("call-1", start)).details).toMatchObject({ state: "indeterminate" });
    await tool.execute("call-2", start);
    expect(request).toHaveBeenCalledTimes(2);
    for (const budget of [{ searches: 2 }, { durationMs: 1 }]) {
      await expect(
        tool.execute("call-3", {
          ...start,
          idempotencyKey: "unsupported",
          request: { ...start.request, budget },
        }),
      ).rejects.toThrow("local duration/call/token budgets");
    }
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("checks conversation generation and live authority before publishing a provider response", async () => {
    const { tool, runtime, current, jobs, context, readStore } = await fixture();
    vi.mocked(runtime.gateway.request)
      .mockResolvedValueOnce(descriptor)
      .mockImplementationOnce(async () => {
        current.mockImplementation(() => {
          throw new Error("retired");
        });
        return completed;
      });
    await expect(tool.execute("call-1", start)).rejects.toThrow("retired");
    current.mockReset();
    const store = readStore();
    const [entry] = await store.entries();
    assert.ok(entry);
    expect(entry.value.result).toBeUndefined();
    await expect(jobs.get(entry.key, { ...context, sessionId: "generation-2" })).rejects.toThrow(
      "conversation generation",
    );
    expect(await jobs.get(entry.key, context)).toMatchObject({ state: "paused", handle });
  });
  it("reconciles a persisted handle on resume and distinguishes a pending cancellation", async () => {
    const { jobs, runtime, context, readStore } = await fixture();
    await expect(jobs.get("seed", context)).rejects.toThrow("not found");
    const store = readStore();
    const job: ResearchJob = {
      version: 1,
      id: "retained-job",
      request: { question: "River", engine: "google" },
      sessionKey: context.sessionKey,
      sessionId: context.sessionId,
      agentId: context.agentId,
      createdAt: 0,
      deadlineAt: 0,
      state: "running",
      progress: "Provider running",
      handle,
    };
    await store.register(job.id, job);
    const recovered = await jobs.get(job.id, context);
    expect(recovered.state).toBe("paused");
    const request = vi.mocked(runtime.gateway.request).mockResolvedValueOnce({
      version: 1,
      ok: true,
      value: { state: "running", handle, citations: [] },
    });
    const cancelled = await jobs.cancel(recovered, context);
    expect(cancelled.state).toBe("paused");
    expect(cancelled.progress).toContain("not confirmed");
    expect(request.mock.calls[0]?.[1]).toMatchObject({ request: { action: "cancel", handle } });
    request.mockResolvedValueOnce({
      version: 1,
      ok: true,
      value: { state: "cancelled", handle, citations: [] },
    });
    expect((await jobs.run(cancelled, context)).state).toBe("cancelled");
  });
});

describe("research recovery fault injection", () => {
  it.each([false, true])(
    "coalesces overlapping starts and ignores a stale resume snapshot after completion (lookup fault: %s)",
    async (lookupFault) => {
      const { jobs, tool, runtime, context } = await fixture();
      const entered = Promise.withResolvers<void>();
      const receipt = Promise.withResolvers<typeof completed>();
      const request = vi
        .mocked(runtime.gateway.request)
        .mockResolvedValueOnce(descriptor)
        .mockImplementationOnce(() => {
          entered.resolve();
          return receipt.promise;
        });
      const first = tool.execute("call-1", start);
      await Promise.race([
        entered.promise,
        first.then(() => {
          throw new Error("Operation ended before submission");
        }),
      ]);
      const duplicate = await jobs.start(
        { question: "Research the river.", engine: "google" },
        "stable-request",
        context,
      );
      expect(duplicate.state).toBe("submitting");
      receipt.resolve(completed);
      await first;
      if (lookupFault) {
        const open = runtime.state.openKeyedStoreV2;
        let failLookup = true;
        runtime.state.openKeyedStoreV2 = <T>(
          options: Parameters<typeof open>[0],
          authority: Parameters<typeof open>[1],
        ) => {
          const store = open<T>(options, authority);
          return {
            ...store,
            lookup: async (...args: Parameters<typeof store.lookup>) => {
              if (failLookup && options.namespace.startsWith("research-jobs-v1-")) {
                failLookup = false;
                throw new Error("Current job read failed");
              }
              return store.lookup(...args);
            },
          };
        };
        await expect(jobs.run(duplicate, context)).rejects.toThrow("Current job read failed");
      }
      const staleResume = await jobs.run(duplicate, context);
      expect(staleResume.state).toBe("completed");
      expect(request).toHaveBeenCalledTimes(2);
      const result = await tool.execute("read-again", { action: "result", jobId: staleResume.id });
      expect(result.details).toMatchObject({ result: { report: "A provider report." } });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["none", "lookup", "before", "after"] as const)(
    "does not resubmit an unknown start from a stale snapshot (storage failure: %s)",
    async (storageFailure) => {
      const { jobs, runtime, context, readStore } = await fixture();
      const parent = new AbortController();
      const entered = Promise.withResolvers<void>();
      const receipt = Promise.withResolvers<unknown>();
      const request = vi
        .mocked(runtime.gateway.request)
        .mockResolvedValueOnce(descriptor)
        .mockImplementationOnce(() => {
          entered.resolve();
          return receipt.promise;
        });
      const running = jobs.start(
        { question: "River", engine: "google" },
        "unknown-stale-resume",
        context,
        parent.signal,
      );
      await entered.promise;
      const [entry] = await readStore().entries();
      assert.ok(entry);
      const staleResume = await jobs.get(entry.key, context);
      expect(staleResume).toMatchObject({ state: "submitting" });
      const stopped = expect(running).rejects.toThrow("parent stopped");
      parent.abort(new Error("parent stopped"));
      receipt.reject(new Error("Unknown transport outcome"));
      await stopped;
      expect(await readStore().lookup(entry.key)).toMatchObject({ state: "submitting" });
      request.mockResolvedValueOnce(descriptor).mockResolvedValueOnce(completed);
      const open = runtime.state.openKeyedStoreV2;
      let failSettlement = storageFailure === "before" || storageFailure === "after";
      let failLookup = storageFailure === "lookup";
      runtime.state.openKeyedStoreV2 = <T>(
        options: Parameters<typeof open>[0],
        authority: Parameters<typeof open>[1],
      ) => {
        const store = open<T>(options, authority);
        return {
          ...store,
          lookup: async (...args: Parameters<typeof store.lookup>) => {
            if (failLookup && options.namespace.startsWith("research-jobs-v1-")) {
              failLookup = false;
              throw new Error("Current job read failed");
            }
            return store.lookup(...args);
          },
          register: async (...args: Parameters<typeof store.register>) => {
            if (
              failSettlement &&
              options.namespace.startsWith("research-jobs-v1-") &&
              (args[1] as ResearchJob).state === "indeterminate"
            ) {
              failSettlement = false;
              if (storageFailure === "after") {
                await store.register(...args);
              }
              throw new Error("Settlement failed");
            }
            return store.register(...args);
          },
        };
      };
      if (storageFailure === "lookup") {
        await expect(jobs.run(staleResume, context)).rejects.toThrow("Current job read failed");
        expect(await readStore().lookup(entry.key)).toMatchObject({ state: "submitting" });
      }
      if (storageFailure === "before" || storageFailure === "after") {
        await expect(jobs.run(staleResume, context)).rejects.toThrow("Settlement failed");
        expect(await readStore().lookup(entry.key)).toMatchObject({
          state: storageFailure === "before" ? "submitting" : "indeterminate",
        });
      }
      expect(await jobs.run(staleResume, context)).toMatchObject({ state: "indeterminate" });
      expect(await readStore().lookup(entry.key)).toMatchObject({ state: "indeterminate" });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("preserves cancellation intent when the provider cannot confirm remote termination", async () => {
    const { jobs, tool, runtime, context } = await fixture();
    const entered = Promise.withResolvers<void>();
    const polling = Promise.withResolvers<unknown>();
    const request = vi
      .mocked(runtime.gateway.request)
      .mockResolvedValueOnce(descriptor)
      .mockResolvedValueOnce({
        version: 1,
        ok: true,
        value: { state: "running", handle, citations: [] },
      })
      .mockImplementationOnce(() => {
        entered.resolve();
        return polling.promise;
      });
    const running = tool.execute("call-1", start);
    await Promise.race([
      entered.promise,
      running.then(() => {
        throw new Error("Operation ended before polling");
      }),
    ]);
    const existing = await jobs.start(
      { question: "Research the river.", engine: "google" },
      "stable-request",
      context,
    );
    await tool.execute("cancel", { action: "cancel", jobId: existing.id });
    request
      .mockResolvedValueOnce({
        version: 1,
        ok: false,
        state: "blocked",
        reason: "Remote cancellation unsupported.",
      })
      .mockResolvedValueOnce(completed);
    polling.resolve({
      version: 1,
      ok: true,
      value: { state: "running", handle, citations: [] },
    });
    expect((await running).details).toMatchObject({ state: "completed" });
    expect(request.mock.calls.at(-2)?.[1]).toMatchObject({ request: { action: "cancel", handle } });
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ request: { action: "poll", handle } });
    const resumed = await tool.execute("resume", { action: "resume", jobId: existing.id });
    expect(resumed.details).toMatchObject({ state: "completed" });
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("cancels during discovery without submitting paid research", async () => {
    const { jobs, tool, runtime, context } = await fixture();
    const entered = Promise.withResolvers<void>();
    const discovery = Promise.withResolvers<typeof descriptor>();
    const request = vi.mocked(runtime.gateway.request).mockImplementationOnce(() => {
      entered.resolve();
      return discovery.promise;
    });
    const running = tool.execute("start", start);
    await Promise.race([
      entered.promise,
      running.then(() => {
        throw new Error("Operation ended before discovery");
      }),
    ]);
    const existing = await jobs.start(
      { question: "Research the river.", engine: "google" },
      "stable-request",
      context,
    );
    await tool.execute("cancel", { action: "cancel", jobId: existing.id });
    discovery.resolve(descriptor);
    expect((await running).details).toMatchObject({ state: "cancelled" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps an in-flight start receipt when cancellation arrives and cancels that handle", async () => {
    const { jobs, tool, runtime, context } = await fixture();
    const entered = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<unknown>();
    let submissionSignal: AbortSignal | undefined;
    const request = vi
      .mocked(runtime.gateway.request)
      .mockResolvedValueOnce(descriptor)
      .mockImplementationOnce((_method, _params, options) => {
        submissionSignal = options?.signal;
        entered.resolve();
        return receipt.promise;
      })
      .mockResolvedValueOnce({
        version: 1,
        ok: true,
        value: { state: "cancelled", handle, citations: [] },
      });
    const running = tool.execute("start", start);
    await Promise.race([
      entered.promise,
      running.then(() => {
        throw new Error("Operation ended before submission");
      }),
    ]);
    const existing = await jobs.start(
      { question: "Research the river.", engine: "google" },
      "stable-request",
      context,
    );
    await tool.execute("cancel", { action: "cancel", jobId: existing.id });
    expect(submissionSignal?.aborted).toBe(false);
    receipt.resolve({ version: 1, ok: true, value: { state: "running", handle, citations: [] } });
    expect((await running).details).toMatchObject({ state: "cancelled" });
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ request: { action: "cancel", handle } });
    await tool.execute("retry", start);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("retains idempotency receipts without sharing one conversation's quota with others", async () => {
    const { jobs, runtime, context, readStore } = await fixture();
    vi.mocked(runtime.gateway.request).mockImplementation(async (_method, params) => {
      return (params as { request: { action: string } }).request.action === "describe"
        ? descriptor
        : completed;
    });
    const first = await jobs.start({ question: "River", engine: "google" }, "one", context);
    const store = readStore();
    for (let index = 1; index < 32; index++) {
      await store.register(`retained-${index}`, { ...first, id: `retained-${index}` });
    }
    await expect(
      jobs.start({ question: "River", engine: "google" }, "overflow", context),
    ).rejects.toThrow();
    const other = await jobs.start({ question: "River", engine: "google" }, "one", {
      ...context,
      sessionKey: "agent:main:another-research-fixture",
      sessionId: "generation-2",
    });
    expect(other.state).toBe("completed");
    expect(other.id).not.toBe(first.id);
    expect((await jobs.start({ question: "River", engine: "google" }, "one", context)).id).toBe(
      first.id,
    );
    expect(runtime.gateway.request).toHaveBeenCalledTimes(4);
  });

  it.each(["conversation-retired", "service-reloaded"] as const)(
    "fences a late poll result after %s and never repeats the submission",
    async (reason) => {
      const { tool, runtime, api, scheduler, context, current, readStore } = await fixture();
      const entered = Promise.withResolvers<void>();
      const late = Promise.withResolvers<typeof completed>();
      const request = vi
        .mocked(runtime.gateway.request)
        .mockResolvedValueOnce(descriptor)
        .mockResolvedValueOnce({
          version: 1,
          ok: true,
          value: { state: "running", handle, citations: [] },
        })
        .mockImplementationOnce(() => {
          entered.resolve();
          return late.promise;
        });
      const running = tool.execute("start", start);
      await Promise.race([
        entered.promise,
        running.then(() => {
          throw new Error("No poll was admitted");
        }),
      ]);
      const rejected = expect(running).rejects.toThrow();
      if (reason === "service-reloaded") {
        await scheduler.stop();
      } else {
        // The host retires this capability on reset/deletion; the feature must
        // consume that live decision even when an already-admitted poll returns.
        current.mockImplementation(() => {
          throw new Error("conversation retired");
        });
      }
      late.resolve(completed);
      await rejected;
      const [entry] = await readStore().entries();
      assert.ok(entry);
      expect(entry.value.handle).toEqual(handle);
      expect(entry.value.result).toBeUndefined();
      expect(request).toHaveBeenCalledTimes(3);
      const nextScheduler = createTestPluginServiceScheduler();
      cleanup.push(() => nextScheduler.stop());
      const reopened = new ResearchJobs(api, nextScheduler);
      if (reason === "conversation-retired") {
        await expect(reopened.get(entry.key, context)).rejects.toThrow("conversation retired");
        await expect(
          reopened.get(entry.key, {
            ...context,
            sessionId: "generation-2",
            assertInvocationCurrent() {},
          }),
        ).rejects.toThrow("conversation generation");
        expect(request).toHaveBeenCalledTimes(3);
      } else {
        request.mockResolvedValueOnce(completed);
        const resumed = await reopened.run(await reopened.get(entry.key, context), context);
        expect(resumed.state).toBe("completed");
        expect(request).toHaveBeenCalledTimes(4);
        expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
          request: { action: "poll", handle },
        });
      }
    },
  );
  it("does not repeat a paid portable operation interrupted before its receipt was saved", async () => {
    const { jobs, api, runtime, scheduler, context, readStore } = await fixture();
    const entered = Promise.withResolvers<void>();
    const pendingResponse =
      Promise.withResolvers<Awaited<ReturnType<typeof runtime.llm.complete>>>();
    const modelResponse = (text: string) => ({
      text,
      provider: "example",
      model: "research-model",
      agentId: "main",
      usage: { totalTokens: 10 },
      execution: {
        mode: "direct-provider" as const,
        owner: { kind: "provider" as const, id: "example" },
      },
      audit: { caller: { kind: "plugin" as const, id: "deep-research" } },
    });
    const complete = vi
      .mocked(runtime.llm.complete)
      .mockResolvedValueOnce(modelResponse('{"questions":["River"]}'))
      .mockImplementationOnce(() => {
        entered.resolve();
        return pendingResponse.promise;
      });
    const running = jobs.start(
      {
        question: "River",
        sources: {
          documents: [{ title: "River", text: "The measured river length is twelve kilometers." }],
        },
      },
      "portable-crash",
      context,
    );
    await Promise.race([
      entered.promise,
      running.then(() => {
        throw new Error("Operation ended before paid completion");
      }),
    ]);
    const rejected = expect(running).rejects.toThrow();
    await scheduler.stop();
    pendingResponse.resolve(modelResponse('{"findings":[],"gaps":[],"queries":[]}'));
    await rejected;
    const nextScheduler = createTestPluginServiceScheduler();
    cleanup.push(() => nextScheduler.stop());
    const reopened = new ResearchJobs(api, nextScheduler);
    const store = readStore();
    const [entry] = await store.entries();
    assert.ok(entry);
    const resumed = await reopened.run(await reopened.get(entry.key, context), context);
    expect(resumed.state).toBe("indeterminate");
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it("retains an admitted create receipt after parent abort while host authority is current", async () => {
    const { jobs, api, runtime, scheduler, context, readStore } = await fixture();
    const parent = new AbortController();
    const admitted = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<unknown>();
    let startSignal: AbortSignal | undefined;
    const request = vi
      .mocked(runtime.gateway.request)
      .mockImplementation(async (_method, params, options) => {
        const requestInput = params?.request;
        const action =
          requestInput && typeof requestInput === "object" && "action" in requestInput
            ? requestInput.action
            : undefined;
        if (action === "describe") {
          return descriptor;
        }
        if (action === "start") {
          startSignal = options?.signal;
          admitted.resolve();
          return receipt.promise;
        }
        return completed;
      });
    const running = jobs.start(
      { question: "River", engine: "google" },
      "parent-abort",
      context,
      parent.signal,
    );
    await admitted.promise;
    const rejected = expect(running).rejects.toThrow("parent stopped");
    parent.abort(new Error("parent stopped"));
    expect(startSignal?.aborted).toBe(false);
    receipt.resolve({ version: 1, ok: true, value: { state: "running", handle, citations: [] } });
    await rejected;
    const [entry] = await readStore().entries();
    assert.ok(entry);
    expect(entry.value).toMatchObject({ state: "paused", handle });
    const reopened = new ResearchJobs(api, scheduler);
    const resumed = await reopened.run(await reopened.get(entry.key, context), context);
    expect(resumed.state).toBe("completed");
    expect(
      request.mock.calls.filter(([, params]) => {
        const requestInput = params?.request;
        return (
          requestInput &&
          typeof requestInput === "object" &&
          "action" in requestInput &&
          requestInput.action === "start"
        );
      }),
    ).toHaveLength(1);
  });

  it("reconciles a known receipt after transient authority refresh without another start", async () => {
    const { jobs, runtime, context } = await fixture();
    const request = vi
      .mocked(runtime.gateway.request)
      .mockResolvedValueOnce(descriptor)
      .mockResolvedValueOnce({
        version: 1,
        ok: false,
        state: "indeterminate",
        handle,
        reason: "Session access is refreshing",
      })
      .mockResolvedValueOnce(completed);
    const job = await jobs.start(
      { question: "River", engine: "google" },
      "refresh-receipt",
      context,
    );
    expect(job).toMatchObject({ state: "paused", handle });
    expect((await jobs.run(job, context)).state).toBe("completed");
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ request: { action: "poll", handle } });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("allows an explicit fresh resume after a known pre-submission rejection", async () => {
    const { jobs, runtime, context } = await fixture();
    vi.mocked(runtime.gateway.request)
      .mockResolvedValueOnce(descriptor)
      .mockResolvedValueOnce({
        version: 1,
        ok: false,
        state: "blocked",
        reason: "Request was not sent",
      })
      .mockResolvedValueOnce(descriptor)
      .mockResolvedValueOnce(completed);
    const job = await jobs.start(
      { question: "River", engine: "google" },
      "blocked-before-start",
      context,
    );
    expect(job.state).toBe("paused");
    expect((await jobs.run(job, context)).state).toBe("completed");
  });

  it("replays retained portable evidence after the deadline without new paid calls", async () => {
    const { jobs, api, runtime, scheduler, context, readStore } = await fixture();
    const quote = "The measured river length is twelve kilometers.";
    const modelResponse = (value: unknown) => ({
      text: JSON.stringify(value),
      provider: "example",
      model: "research-model",
      agentId: "main",
      usage: { totalTokens: 10 },
      execution: {
        mode: "direct-provider" as const,
        owner: { kind: "provider" as const, id: "example" },
      },
      audit: { caller: { kind: "plugin" as const, id: "deep-research" } },
    });
    const complete = vi
      .mocked(runtime.llm.complete)
      .mockResolvedValueOnce(modelResponse({ questions: ["River"] }))
      .mockResolvedValueOnce(
        modelResponse({
          findings: [
            {
              statement: "The river is twelve kilometers long.",
              evidence: [{ sourceId: "S1", quote }],
            },
          ],
          gaps: [],
          queries: [],
        }),
      )
      .mockResolvedValueOnce(
        modelResponse({
          verdicts: [{ index: 0, verdict: "supported", reason: "Exact measurement" }],
          unanswered: [],
        }),
      );
    const first = await jobs.start(
      { question: "River", sources: { documents: [{ title: "River report", text: quote }] } },
      "expired-portable",
      context,
    );
    expect(first.state).toBe("completed");
    const { result: _result, ...retained } = first;
    await readStore().register(first.id, {
      ...retained,
      state: "running",
      deadlineAt: scheduler.now() - 1,
    });
    const reopened = new ResearchJobs(api, scheduler);
    const resumed = await reopened.run(await reopened.get(first.id, context), context);
    expect(resumed.state).toBe("partial");
    expect(resumed.result?.findings).toEqual(first.result?.findings);
    expect(resumed.result?.report).toContain("The river is twelve kilometers long.");
    expect(resumed.result?.gaps).toContain(
      "Global research deadline exhausted; only recorded evidence was replayed, with no new calls.",
    );
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("starts a queued portable budget on admission and returns a report even with no old receipts", async () => {
    const { jobs, runtime, scheduler, context, readStore } = await fixture();
    await expect(jobs.get("seed", context)).rejects.toThrow("not found");
    const queued: ResearchJob = {
      version: 1,
      id: "queued-portable",
      request: { question: "River", sources: { web: false } },
      sessionKey: context.sessionKey,
      sessionId: context.sessionId,
      agentId: context.agentId,
      createdAt: scheduler.now() - 1_000_000,
      deadlineAt: 0,
      state: "queued",
      progress: "Queued",
    };
    await readStore().register(queued.id, queued);
    vi.mocked(runtime.llm.complete).mockResolvedValue({
      text: '{"questions":["River"]}',
      provider: "example",
      model: "research-model",
      agentId: "main",
      usage: { totalTokens: 10 },
      execution: { mode: "direct-provider", owner: { kind: "provider", id: "example" } },
      audit: { caller: { kind: "plugin", id: "deep-research" } },
    });
    const admitted = await jobs.run(queued, context);
    expect(admitted.deadlineAt).toBeGreaterThan(queued.createdAt + 180_000);
    expect(runtime.llm.complete).toHaveBeenCalledTimes(1);
    const expired = { ...queued, id: "expired-empty", deadlineAt: scheduler.now() - 1 };
    await readStore().register(expired.id, expired);
    const result = await jobs.run(expired, context);
    expect(result.result?.report).toContain("Global research deadline exhausted");
    expect(runtime.llm.complete).toHaveBeenCalledTimes(1);
  });
  it.each([
    { gatewayCode: "UNAVAILABLE", details: { code: "SESSION_ACCESS_REFRESHING" }, retryable: true },
    { gatewayCode: "FORBIDDEN", details: { code: "SESSION_ACCESS_CHANGED" }, retryable: false },
    {
      gatewayCode: "FORBIDDEN",
      details: { code: "SESSION_RESOURCE_TOOL_POLICY" },
      retryable: false,
    },
    { gatewayCode: "UNAVAILABLE", details: { code: "PAIRING_CHANGED" }, retryable: true },
    { gatewayCode: "UNAVAILABLE", details: { reason: "startup-sidecars" }, retryable: true },
  ])("pauses an explicitly identified router refusal: $details", async (refusal) => {
    const { jobs, runtime, context } = await fixture();
    const request = vi
      .mocked(runtime.gateway.request)
      .mockResolvedValueOnce(descriptor)
      .mockRejectedValueOnce(
        Object.assign(new Error("Router refused request"), {
          name: "GatewayClientRequestError",
          ...refusal,
        }),
      )
      .mockResolvedValueOnce(descriptor)
      .mockResolvedValueOnce(completed);
    const job = await jobs.start(
      { question: "River", engine: "google" },
      "router-refusal",
      context,
    );
    expect(job).toMatchObject({ state: "paused" });
    expect(job.handle).toBeUndefined();
    expect((await jobs.run(job, context)).state).toBe("completed");
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("does not infer never-sent from an unclassified retryable protocol error", async () => {
    const { jobs, runtime, context, readStore } = await fixture();
    const request = vi
      .mocked(runtime.gateway.request)
      .mockResolvedValueOnce(descriptor)
      .mockRejectedValueOnce(
        Object.assign(new Error("Unknown transport outcome"), {
          name: "GatewayClientRequestError",
          gatewayCode: "UNAVAILABLE",
          retryable: true,
          details: { code: "UNKNOWN" },
        }),
      );
    await expect(
      jobs.start({ question: "River", engine: "google" }, "unknown-router-outcome", context),
    ).rejects.toThrow("Unknown transport outcome");
    const [entry] = await readStore().entries();
    assert.ok(entry);
    expect(entry.value.state).toBe("indeterminate");
    expect((await jobs.run(await jobs.get(entry.key, context), context)).state).toBe(
      "indeterminate",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
});
