import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { createOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  reclaimNativeSessionGenerationWithAuthority,
  resolveNativeSessionBindingWithAuthorityV2,
  type NativeSessionGenerationOperationsV2,
} from "./binding-generation-authority.js";

const createSupersededError = (sessionId: string) =>
  new Error(`Session generation is no longer current: ${sessionId}`);

describe("native session binding generation authority", () => {
  let storePath: string;
  const target = {
    agentId: "main",
    sessionId: "session-current",
    sessionKey: "agent:main:readable",
  };
  const binding = { value: "native-owner" };
  const scope = () => ({ agentId: target.agentId, sessionKey: target.sessionKey, storePath });

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
      const pending = resolveNativeSessionBindingWithAuthorityV2({
        target: state === "stale" ? { ...target, sessionId: "session-stale" } : target,
        storePath,
        readBinding: async () => binding,
        createSupersededError,
        assertCurrent: () => {
          if (!active) {
            throw new Error("caller authority closed");
          }
        },
      });
      if (state === "stale") {
        await expect(pending).rejects.toThrow("Session generation is no longer current");
        return;
      }
      const resolved = await pending;
      expect(resolved.binding).toEqual(binding);
      await expect(resolved.authority.withCurrent(() => undefined)).resolves.toBeUndefined();
      if (state === "ephemeral") {
        active = false;
      } else {
        await patchSessionEntryCore(scope(), () => ({ sessionId: "session-successor" }));
      }
      await expect(resolved.authority.withCurrent(() => undefined)).rejects.toThrow(
        state === "ephemeral"
          ? "caller authority closed"
          : "Session generation is no longer current",
      );
    },
  );

  it("rechecks host generation after an awaited binding read", async () => {
    await upsertSessionEntryCore(scope(), { sessionId: target.sessionId, updatedAt: 1 });
    const reading = createDeferred();
    const release = createDeferred();
    const pending = resolveNativeSessionBindingWithAuthorityV2({
      target,
      storePath,
      createSupersededError,
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
        const reclaim = () => {
          throw new Error("Stale reclaim is disabled");
        };
        return authority.withCurrent(reclaim);
      },
    };
    await upsertSessionEntryCore(scope(), { sessionId: previous.sessionId, updatedAt: 1 });
    await patchSessionEntryCore(scope(), () => ({ sessionId: target.sessionId }));
    const outcome = reclaimNativeSessionGenerationWithAuthority({
      target,
      storePath,
      generation,
      reclaimStale: false,
      createSupersededError,
    }).catch((error: unknown) => error);
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
    await expect(
      reclaimNativeSessionGenerationWithAuthority({
        target: next,
        storePath,
        generation,
        reclaimStale: false,
        createSupersededError,
      }),
    ).resolves.toBe(false);
  });
});
