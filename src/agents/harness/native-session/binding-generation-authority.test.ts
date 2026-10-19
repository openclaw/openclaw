import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { bindingGate } from "./binding-interleaving.test-support.js";

const createSupersededError = (sessionId: string) =>
  new Error(`Session generation is no longer current: ${sessionId}`);

function expectAuthority(
  authority: { assertCurrent(): void; assertLegacyCurrent(): void },
  error?: string,
) {
  for (const check of [() => authority.assertCurrent(), () => authority.assertLegacyCurrent()]) {
    if (error) {
      expect(check).toThrow(error);
    } else {
      expect(check).not.toThrow();
    }
  }
}

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
  const retain = (assertCurrent?: () => void) =>
    retainNativeSessionGenerationAuthority({ ...params(), assertCurrent });
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

  it.each(["current", "stale", "ephemeral", "rotated-during-read"] as const)(
    "fences a %s readable binding",
    async (state) => {
      let active = true;
      await using gate = bindingGate();
      await upsertSessionEntryCore(
        state === "ephemeral" ? { ...scope(), sessionKey: "agent:main:other" } : scope(),
        { sessionId: state === "ephemeral" ? "session-other" : target.sessionId, updatedAt: 1 },
      );
      const pending = resolve({
        target: state === "stale" ? { ...target, sessionId: "session-stale" } : target,
        readBinding: async () => {
          if (state === "rotated-during-read") {
            await gate.pause();
          }
          return binding;
        },
        assertCurrent: () => {
          if (!active) {
            throw new Error("caller authority closed");
          }
        },
      });
      if (state === "rotated-during-read") {
        void gate.observe(pending);
        await gate.reached;
        await patchSessionEntryCore(scope(), () => ({ sessionId: "session-successor" }));
        gate.resume();
        await expect(pending).rejects.toThrow(createSupersededError(target.sessionId));
        return;
      }
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

  it("retains published lineage through foreground abort and terminal cleanup without main-thread SQL", async () => {
    await seed();
    const controller = new AbortController();
    const retained = await retain(() => controller.signal.throwIfAborted());
    using _ = { [Symbol.dispose]: () => retained.release() };
    const cleanup = retained.authority.withLiveness(() => {});
    const calls = observeMainThreadSql();
    try {
      expectAuthority(retained.authority);
      await retained.authority.withCurrent(() => undefined);
      await cleanup.prepareMutation();
      calls.expectIdle();

      controller.abort(new Error("foreground stopped"));
      expectAuthority(retained.authority, "foreground stopped");
      expectAuthority(cleanup);
      await patchSessionEntryCore(scope(), () => ({ label: "renamed" }));
      calls.clear();
      expectAuthority(cleanup);
      calls.expectIdle();

      await patchSessionEntryCore(scope(), () => ({ previousSessionId: "changed-predecessor" }));
      calls.clear();
      expectAuthority(cleanup, superseded);
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
    await using gate = bindingGate();
    const generation: NativeSessionGenerationOperationsV2 = {
      prepareReclaim: async () => {
        await gate.pause();
        return { kind: "verify", expectedPreviousSessionId: bindingSessionId };
      },
      adopt: async (_expectedPreviousSessionId, authority) => {
        return authority.withCurrent(() => {
          bindingSessionId = target.sessionId;
          return "adopted" as const;
        });
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
    const outcome = gate.observe(reclaim());
    await gate.reached;
    await patchSessionEntryCore(scope(), () => ({ sessionId: next.sessionId }));
    gate.resume();

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
