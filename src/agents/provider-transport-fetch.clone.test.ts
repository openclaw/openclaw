import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  buildGuardedModelFetch,
  ensureModelProviderLocalServiceMock,
  fetchWithSsrFGuardMock,
  installProviderTransportFetchTestHooks,
} from "./provider-transport-fetch.test-harness.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

describe("buildGuardedModelFetch response clones", () => {
  installProviderTransportFetchTestHooks();

  it.each([
    {
      name: "JSON-to-SSE synthesis",
      contentType: "application/json",
      expectedError: /exceeded.*bytes while synthesizing SSE/i,
    },
    {
      name: "SSE sanitization",
      contentType: "text/event-stream",
      expectedError: /exceeded max buffer size/i,
    },
  ])("surfaces $name errors without waiting for an unread response clone", async (testCase) => {
    const cancel = vi.fn();
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
        },
        cancel,
      }),
      { headers: { "content-type": testCase.contentType } },
    );
    const unreadClone = upstream.clone();
    const cleanupStarted = createDeferredCore();
    const leaseReleased = createDeferredCore();
    const release = vi.fn(async () => {
      cleanupStarted.resolve();
    });
    const releaseLease = vi.fn(() => leaseReleased.resolve());
    ensureModelProviderLocalServiceMock.mockResolvedValue({ release: releaseLease });
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: upstream,
      finalUrl: "https://openrouter.ai/api/v1/chat/completions",
      release,
    });
    const model = makeProviderModelFixture<"openai-completions">({
      id: "gpt-5.4",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.4", stream: true }),
      },
    );
    const reader = response.body!.getReader();
    const reading = reader.read().then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    try {
      await cleanupStarted.promise;
      // The source has already triggered cleanup. Drain this task's microtasks,
      // not a wall-clock timeout, while the native tee's sibling remains open.
      const result = await Promise.race([
        reading,
        new Promise<undefined>((resolve) => {
          setImmediate(() => resolve(undefined));
        }),
      ]);
      expect(result).toEqual({
        status: "rejected",
        error: expect.objectContaining({ message: expect.stringMatching(testCase.expectedError) }),
      });
      await leaseReleased.promise;
      expect(release).toHaveBeenCalledTimes(1);
      expect(releaseLease).toHaveBeenCalledTimes(1);
      expect(upstream.body!.locked).toBe(false);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      await unreadClone.body?.cancel();
      await reading;
      reader.releaseLock();
    }
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });
});

describe("provider stream error cleanup ownership", () => {
  installProviderTransportFetchTestHooks();

  it.each([
    { contentType: "application/json", rejectsCleanup: false },
    { contentType: "application/json", rejectsCleanup: true },
    { contentType: "text/event-stream", rejectsCleanup: false },
    { contentType: "text/event-stream", rejectsCleanup: true },
  ])("retains $contentType physical cleanup (rejects: $rejectsCleanup)", async (testCase) => {
    const owner = new AsyncWorkScope();
    const consumer = new AsyncWorkScope();
    const cancellationStarted = createDeferredCore();
    const finishCancellation = createDeferredCore();
    const releaseStarted = createDeferredCore();
    const finishRelease = createDeferredCore();
    const leaseReleased = createDeferredCore();
    const cancel = vi.fn(() => {
      cancellationStarted.resolve();
      return finishCancellation.promise;
    });
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
        },
        cancel,
      }),
      { headers: { "content-type": testCase.contentType } },
    );
    const clone = upstream.clone();
    const release = vi.fn(() => {
      releaseStarted.resolve();
      return finishRelease.promise;
    });
    const releaseLease = vi.fn(() => leaseReleased.resolve());
    ensureModelProviderLocalServiceMock.mockResolvedValue({ release: releaseLease });
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: upstream,
      finalUrl: "https://openrouter.ai/api/v1/chat/completions",
      release,
    });
    const model = makeProviderModelFixture<"openai-completions">({
      id: "gpt-5.4",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    const response = await owner.track(() =>
      buildGuardedModelFetch(model)("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.4", stream: true }),
      }),
    );
    const reader = response.body!.getReader();
    const reading = consumer
      .track(() => reader.read())
      .then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
    let cloneCancellation: Promise<unknown> | undefined;
    let drained = false;

    try {
      await releaseStarted.promise;
      const result = await Promise.race([
        reading,
        new Promise<undefined>((resolve) => {
          setImmediate(() => resolve(undefined));
        }),
      ]);
      expect(result).toEqual({
        status: "rejected",
        error: expect.objectContaining({
          message: expect.stringMatching(
            testCase.contentType === "application/json"
              ? /exceeded.*bytes while synthesizing SSE/i
              : /exceeded max buffer size/i,
          ),
        }),
      });
      expect(consumer.hasPendingWork).toBe(false);
      expect(owner.hasPendingWork).toBe(true);
      expect(upstream.body!.locked).toBe(false);
      expect(release).toHaveBeenCalledTimes(1);
      expect(releaseLease).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      const draining = owner.drain().then(() => {
        drained = true;
      });

      cloneCancellation = clone.body!.cancel().catch((error: unknown) => error);
      await cancellationStarted.promise;
      expect(owner.hasPendingWork).toBe(true);
      expect(drained).toBe(false);
      if (testCase.rejectsCleanup) {
        finishCancellation.reject(new Error("upstream cancellation failed"));
      } else {
        finishCancellation.resolve();
      }
      await cloneCancellation;
      // Finishing the native tee is not enough: guard release is still physical work.
      expect(owner.hasPendingWork).toBe(true);
      expect(drained).toBe(false);
      if (testCase.rejectsCleanup) {
        finishRelease.reject(new Error("guard release failed"));
      } else {
        finishRelease.resolve();
      }
      await leaseReleased.promise;
      await draining;
      expect(owner.hasPendingWork).toBe(false);
      expect(drained).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      expect(releaseLease).toHaveBeenCalledTimes(1);
      if (result?.status === "rejected") {
        await expect(reader.read()).rejects.toBe(result.error);
      }
    } finally {
      finishCancellation.resolve();
      finishRelease.resolve();
      cloneCancellation ??= clone.body!.cancel().catch(() => undefined);
      await Promise.allSettled([cloneCancellation, reading]);
      reader.releaseLock();
      await Promise.all([owner.drain(), consumer.drain()]);
    }
  });
});

function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("provider cancellation from a foreign pull", () => {
  installProviderTransportFetchTestHooks();

  it.each(["open", "closing", "closed"] as const)(
    "starts cleanup and its descendants with a %s response owner",
    async (ownerState) => {
      const owner = new AsyncWorkScope();
      const consumer = new AsyncWorkScope();
      const requestContext = new AsyncLocalStorage<string>();
      const descendantStarted = createDeferredCore();
      const finishDescendant = createDeferredCore();
      const leaseReleased = createDeferredCore();
      let descendant: Promise<void> | undefined;
      let descendantSettled = false;
      let constructionComplete = false;
      let overflowInjected = false;
      const observations: Array<{
        signal: AbortSignal | undefined;
        context: string | undefined;
        constructionComplete: boolean;
        overflowInjected: boolean;
      }> = [];
      const observeContext = () => {
        observations.push({
          signal: getAsyncWorkSignal(),
          context: requestContext.getStore(),
          constructionComplete,
          overflowInjected,
        });
      };
      const release = vi.fn(async () => {
        observeContext();
        // This is cooperating work, not the release callback's returned promise.
        descendant = trackAsyncWork(async () => {
          observeContext();
          descendantStarted.resolve();
          await finishDescendant.promise;
          descendantSettled = true;
        });
        void descendant.catch(() => undefined);
        throw new Error("guard release failed");
      });
      const cancel = vi.fn(async () => {
        throw new Error("source cancellation failed");
      });
      const releaseLease = vi.fn(() => leaseReleased.resolve());
      let sourceController!: ReadableStreamDefaultController<Uint8Array>;
      const firstFrame = new TextEncoder().encode('data: {"ok":true}\n\n');
      const upstream = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            sourceController = controller;
            controller.enqueue(firstFrame);
          },
          cancel,
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
      const clone = upstream.clone();
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: upstream,
        finalUrl: "https://openrouter.ai/api/v1/chat/completions",
        release,
      });
      ensureModelProviderLocalServiceMock.mockResolvedValue({ release: releaseLease });
      const model = makeProviderModelFixture<"openai-completions">({
        id: "gpt-5.4",
        provider: "openrouter",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
      });
      const response = await requestContext.run("construction", () =>
        owner.track(() =>
          buildGuardedModelFetch(model)("https://openrouter.ai/api/v1/chat/completions"),
        ),
      );
      constructionComplete = true;
      const reader = response.body!.getReader();
      let reading: Promise<unknown> | undefined;
      let cloneCancellation: Promise<unknown> | undefined;
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);

      try {
        // Allow constructor prefetch to fill its one output slot and finish.
        // No overflow bytes exist yet, so this cannot be an already-errored stream.
        await nextTask();
        expect(owner.hasPendingWork).toBe(false);
        expect(release).not.toHaveBeenCalled();
        expect(overflowInjected).toBe(false);
        if (ownerState === "closed") {
          await owner.drain();
        } else if (ownerState === "closing") {
          owner.beginClose();
        }
        const first = await requestContext.run("consumer", () =>
          consumer.track(() => reader.read()),
        );
        expect(first).toEqual({ done: false, value: firstFrame });
        // Dequeuing the valid frame starts the next native sanitizer pull from
        // the foreign consumer. Let it block for input before injecting failure.
        await nextTask();
        expect(release).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        const resultPromise = requestContext
          .run("consumer", () => consumer.track(() => reader.read()))
          .then(
            () => ({ status: "resolved" as const }),
            (error: unknown) => ({ status: "rejected" as const, error }),
          );
        reading = resultPromise;
        requestContext.run("consumer", () =>
          consumer.run(() => {
            overflowInjected = true;
            sourceController.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
          }),
        );
        const result = await Promise.race([resultPromise, nextTask().then(() => undefined)]);
        expect(result).toEqual({
          status: "rejected",
          error: expect.objectContaining({
            message: expect.stringMatching(/exceeded max buffer size/i),
          }),
        });
        await descendantStarted.promise;
        await leaseReleased.promise;
        expect(observations).toHaveLength(2);
        for (const observation of observations) {
          expect(observation.signal).toBe(ownerState === "closed" ? undefined : owner.signal);
          expect(observation).toMatchObject({
            context: "consumer",
            constructionComplete: true,
            overflowInjected: true,
          });
        }
        expect(upstream.body!.locked).toBe(false);
        expect(cancel).not.toHaveBeenCalled();
        cloneCancellation = clone.body!.cancel().catch((error: unknown) => error);
        await cloneCancellation;
        // Drain all outer cancellation/release reactions; only the separately
        // tracked descendant is still held. This distinguishes starting under
        // the owner from merely adopting an already-started outer promise.
        await nextTask();
        let ownerDrained = false;
        let consumerDrained = false;
        const drainOwner = owner.drain().then(() => {
          ownerDrained = true;
        });
        const drainConsumer = consumer.drain().then(() => {
          consumerDrained = true;
        });
        await nextTask();
        expect(consumerDrained).toBe(true);
        expect(ownerDrained).toBe(ownerState === "closed");
        expect(owner.hasPendingWork).toBe(ownerState !== "closed");
        expect(descendantSettled).toBe(false);
        finishDescendant.resolve();
        await descendant;
        await Promise.all([drainOwner, drainConsumer]);
        expect(descendantSettled).toBe(true);
        expect(release).toHaveBeenCalledTimes(1);
        expect(releaseLease).toHaveBeenCalledTimes(1);
        expect(cancel).toHaveBeenCalledTimes(1);
        if (result?.status === "rejected") {
          await expect(reader.read()).rejects.toBe(result.error);
        }
        await nextTask();
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        finishDescendant.resolve();
        const readerCancellation = reader.cancel().catch(() => undefined);
        cloneCancellation ??= clone.body!.cancel().catch(() => undefined);
        await Promise.allSettled([cloneCancellation, readerCancellation, reading, descendant]);
        reader.releaseLock();
        await Promise.all([owner.drain(), consumer.drain()]);
        process.off("unhandledRejection", unhandled);
        requestContext.disable();
      }
    },
  );

  it.each(["application/json", "text/event-stream"])(
    "still awaits explicit consumer cancellation for %s",
    async (contentType) => {
      const releaseStarted = createDeferredCore();
      const cancellationStarted = createDeferredCore();
      const finishCancellation = createDeferredCore();
      const cancel = vi.fn(() => {
        cancellationStarted.resolve();
        return finishCancellation.promise;
      });
      const upstream = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"ok":true}'));
          },
          cancel,
        }),
        { headers: { "content-type": contentType } },
      );
      const clone = upstream.clone();
      const release = vi.fn(async () => {
        releaseStarted.resolve();
      });
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: upstream,
        finalUrl: "https://openrouter.ai/api/v1/chat/completions",
        release,
      });
      const model = makeProviderModelFixture<"openai-completions">({
        id: "gpt-5.4",
        provider: "openrouter",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
      });
      const response = await buildGuardedModelFetch(model)(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-5.4", stream: true }),
        },
      );
      let settled = false;
      const cancellation = response.body!.cancel("consumer stopped").then(() => {
        settled = true;
      });
      let cloneCancellation: Promise<unknown> | undefined;
      try {
        await releaseStarted.promise;
        await nextTask();
        expect(settled).toBe(false);
        expect(cancel).not.toHaveBeenCalled();
        cloneCancellation = clone.body!.cancel().catch((error: unknown) => error);
        await cancellationStarted.promise;
        expect(settled).toBe(false);
        finishCancellation.reject(new Error("upstream cancellation failed"));
        await expect(cancellation).resolves.toBeUndefined();
        expect(settled).toBe(true);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(1);
      } finally {
        finishCancellation.resolve();
        cloneCancellation ??= clone.body!.cancel().catch(() => undefined);
        await Promise.allSettled([cloneCancellation, cancellation]);
      }
    },
  );
});
