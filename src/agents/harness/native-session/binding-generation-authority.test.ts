import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { withPluginRuntimePluginScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { createOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  prepareNativeSessionGenerationAuthority,
  reclaimNativeSessionGenerationWithAuthority,
  retainNativeSessionGenerationAuthority,
  resolvePreparedNativeSessionBinding,
  type NativeSessionGenerationOperationsV2,
} from "./binding-generation-authority.js";

const createSupersededError = (sessionId: string) =>
  new Error(`Session generation is no longer current: ${sessionId}`);

it("warns once for legacy generation preparation and leaves retained authority quiet", async () => {
  using warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  await withPluginRuntimePluginScope({ pluginId: "native-generation-deprecation" }, async () => {
    const params = {
      target: { agentId: "main", sessionId: "ephemeral" },
      storePath: "unused",
      createSupersededError,
    };
    const retained = await retainNativeSessionGenerationAuthority(params);
    retained.release();
    expect(warning).not.toHaveBeenCalled();
    expect((await prepareNativeSessionGenerationAuthority(params)).state).toBe("ephemeral");
    expect((await prepareNativeSessionGenerationAuthority(params)).state).toBe("ephemeral");
  });
  expect(warning).toHaveBeenCalledOnce();
  expect(warning.mock.calls[0]?.[0]).toContain("prepareNativeSessionGenerationAuthority");
  expect(warning.mock.calls[0]?.[0]).toContain("retainNativeSessionGenerationAuthority");
  expect(warning.mock.calls[0]?.[0]).toContain("Final compatibility day: 2026-12-31");
  expect(warning.mock.calls[0]?.[0]).toContain("first January 2027 stable release");
});

describe("native session binding generation authority", () => {
  let storePath: string;
  const target = {
    agentId: "main",
    sessionId: "session-current",
    sessionKey: "agent:main:readable",
  };
  const binding = { value: "native-owner" };
  const scope = () => ({ agentId: target.agentId, sessionKey: target.sessionKey, storePath });
  const params = () => ({ target, storePath, createSupersededError });
  const seed = () => upsertSessionEntryCore(scope(), { sessionId: target.sessionId, updatedAt: 1 });
  const retain = (
    overrides: Partial<Parameters<typeof retainNativeSessionGenerationAuthority>[0]> = {},
  ) => retainNativeSessionGenerationAuthority({ ...params(), ...overrides });
  const resolve = (
    overrides: Partial<
      Parameters<typeof resolvePreparedNativeSessionBinding<typeof binding>>[0]
    > = {},
  ) =>
    resolvePreparedNativeSessionBinding({
      ...params(),
      readBinding: async () => binding,
      ...overrides,
    });
  const superseded = "Session generation is no longer current";

  beforeEach(async ({ onTestFinished }) => {
    const fixture = await createOpenClawTestState({
      prefix: "native-generation-",
      layout: "state-only",
      applyEnv: false,
    });
    onTestFinished(() => fixture.cleanup());
    storePath = path.join(fixture.stateDir, "sessions.json");
  });

  it.each(["current", "stale", "ephemeral"] as const)(
    "fences a %s readable binding",
    async (state) => {
      let active = true;
      await upsertSessionEntryCore(
        state === "ephemeral" ? { ...scope(), sessionKey: "agent:main:other" } : scope(),
        { sessionId: state === "ephemeral" ? "session-other" : target.sessionId, updatedAt: 1 },
      );
      const pending = resolve({
        target: state === "stale" ? { ...target, sessionId: "session-stale" } : target,
        assertCurrent: () => {
          if (!active) {
            throw new Error("caller authority closed");
          }
        },
      });
      if (state === "stale") {
        await expect(pending).rejects.toThrow(superseded);
        return;
      }
      const resolved = await pending;
      using _ = { [Symbol.dispose]: () => resolved.release() };
      expect(resolved.binding).toEqual(binding);
      await expect(resolved.authority.withCurrent(() => undefined)).resolves.toBeUndefined();
      if (state === "ephemeral") {
        active = false;
      } else {
        await patchSessionEntryCore(scope(), () => ({ sessionId: "session-successor" }));
      }
      const error = state === "ephemeral" ? "caller authority closed" : superseded;
      expect(() => resolved.authority.assertCurrent()).toThrow(error);
      await expect(resolved.authority.withCurrent(() => undefined)).rejects.toThrow(error);
    },
  );

  it("rechecks host generation after an awaited binding read", async () => {
    await seed();
    const reading = createDeferred();
    const release = createDeferred();
    const pending = resolve({
      readBinding: async () => {
        reading.resolve();
        await release.promise;
        return binding;
      },
    }).catch((error: unknown) => error);
    await reading.promise;
    try {
      await patchSessionEntryCore(scope(), () => ({ sessionId: "session-successor" }));
    } finally {
      release.resolve();
    }
    expect(await pending).toMatchObject({
      message: `Session generation is no longer current: ${target.sessionId}`,
    });
  });

  it("retains published lineage through foreground abort and terminal cleanup without main-thread SQL", async () => {
    await seed();
    const controller = new AbortController();
    const retained = await retain({
      assertCurrent: () => controller.signal.throwIfAborted(),
    });
    using _ = { [Symbol.dispose]: () => retained.release() };
    const cleanup = retained.authority.withLiveness(() => {});
    const calls = observeMainThreadSql();
    try {
      retained.authority.assertCurrent();
      retained.authority.assertLegacyCurrent();
      await retained.authority.withCurrent(() => undefined);
      await cleanup.prepareMutation();
      calls.expectIdle();

      controller.abort(new Error("foreground stopped"));
      expect(() => retained.authority.assertCurrent()).toThrow("foreground stopped");
      expect(() => retained.authority.assertLegacyCurrent()).toThrow("foreground stopped");
      expect(() => cleanup.assertCurrent()).not.toThrow();
      expect(() => cleanup.assertLegacyCurrent()).not.toThrow();
      await patchSessionEntryCore(scope(), () => ({ label: "renamed" }));
      calls.clear();
      expect(() => cleanup.assertCurrent()).not.toThrow();
      expect(() => cleanup.assertLegacyCurrent()).not.toThrow();
      calls.expectIdle();

      await patchSessionEntryCore(scope(), () => ({ previousSessionId: "changed-predecessor" }));
      calls.clear();
      expect(() => cleanup.assertCurrent()).toThrow("Session generation is no longer current");
      expect(() => cleanup.assertLegacyCurrent()).toThrow(
        "Session generation is no longer current",
      );
      calls.expectIdle();
    } finally {
      calls.restore();
    }
  });

  it("releases a composed child capture without releasing its borrowed parent", async () => {
    await seed();
    const parent = await retain();
    using _ = { [Symbol.dispose]: () => parent.release() };
    const child = await resolve({ authority: parent.authority });
    const cleanup = child.authority.withLiveness(() => {});
    child.release();
    expect(() => cleanup.assertLegacyCurrent()).toThrow(superseded);
    expect(() => parent.authority.assertLegacyCurrent()).not.toThrow();
    parent.release();
    expect(() => parent.authority.assertLegacyCurrent()).toThrow(superseded);
  });

  it("consumes transferred lineage even when resolver admission is already revoked", async () => {
    await seed();
    const retained = await retain();
    using _ = { [Symbol.dispose]: () => retained.release() };
    const controller = new AbortController();
    controller.abort(new Error("resolver revoked"));
    await expect(
      resolve({
        generationAuthority: retained,
        signal: controller.signal,
      }),
    ).rejects.toThrow("resolver revoked");
    expect(() => retained.authority.assertLegacyCurrent()).toThrow(superseded);
  });

  it("does not bridge two generations when the host rotates during a predecessor wait", async () => {
    const previous = { ...target, sessionId: "previous" };
    const next = { ...previous, sessionId: "next" };
    let bindingSessionId = previous.sessionId;
    const { promise: preparationStarted, resolve: markPreparationStarted } = createDeferred();
    const { promise: preparationReleased, resolve: finishPreparation } = createDeferred();
    const generation: NativeSessionGenerationOperationsV2 = {
      prepareReclaim: async () => {
        markPreparationStarted();
        await preparationReleased;
        return { kind: "verify", expectedPreviousSessionId: bindingSessionId };
      },
      adopt: async (_expectedPreviousSessionId, authority) => {
        const adopt = () => {
          bindingSessionId = target.sessionId;
          return "adopted" as const;
        };
        return authority.withCurrent(adopt);
      },
      reclaim: async (_expectedPreviousSessionId, authority) => {
        return authority.withCurrent(() => {
          throw new Error("Stale reclaim is disabled");
        });
      },
    };
    await upsertSessionEntryCore(scope(), { sessionId: previous.sessionId, updatedAt: 1 });
    await patchSessionEntryCore(scope(), () => ({ sessionId: target.sessionId }));
    const reclaim = (currentTarget = target) =>
      reclaimNativeSessionGenerationWithAuthority({
        ...params(),
        target: currentTarget,
        generation,
        reclaimStale: false,
      });
    const outcome = reclaim().catch((error: unknown) => error);
    await preparationStarted;
    await patchSessionEntryCore(scope(), () => ({ sessionId: next.sessionId }));
    finishPreparation();

    expect(await outcome).toMatchObject({
      message: `Session generation is no longer current: ${target.sessionId}`,
    });
    expect(bindingSessionId).toBe(previous.sessionId);
    expect(loadSessionEntryReadOnly(scope())).toMatchObject({
      sessionId: next.sessionId,
      previousSessionId: target.sessionId,
    });
    await expect(reclaim(next)).resolves.toBe(false);
  });
});
