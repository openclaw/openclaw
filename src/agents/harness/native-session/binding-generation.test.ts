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
  reclaimNativeSessionGeneration,
  resolveNativeSessionBinding,
  type NativeSessionGenerationOperations,
} from "./binding-generation.js";

const createSupersededError = (sessionId: string) =>
  new Error(`Session generation is no longer current: ${sessionId}`);

describe("native session binding generation", () => {
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

  it.each(["current", "stale", "ephemeral"])("fences a %s readable binding", async (state) => {
    let active = true;
    await upsertSessionEntryCore(
      state === "ephemeral" ? { ...scope(), sessionKey: "agent:main:other" } : scope(),
      { sessionId: state === "ephemeral" ? "session-other" : target.sessionId, updatedAt: 1 },
    );
    const pending = resolveNativeSessionBinding({
      target: state === "stale" ? { ...target, sessionId: "session-stale" } : target,
      storePath,
      readBinding: () => binding,
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
    expect(resolved.assertCurrent).not.toThrow();
    if (state === "ephemeral") {
      active = false;
    } else {
      await patchSessionEntryCore(scope(), () => ({ sessionId: "session-successor" }));
    }
    expect(resolved.assertCurrent).toThrow(
      state === "ephemeral" ? "caller authority closed" : "Session generation is no longer current",
    );
  });

  it("does not bridge two generations when the host rotates during a predecessor wait", async () => {
    const previous = { ...target, sessionId: "previous" };
    const next = { ...previous, sessionId: "next" };
    let bindingSessionId = previous.sessionId;
    const { promise: preparationStarted, resolve: markPreparationStarted } = createDeferred();
    const { promise: preparationReleased, resolve: finishPreparation } = createDeferred();
    const generation: NativeSessionGenerationOperations = {
      prepareReclaim: async () => {
        markPreparationStarted();
        await preparationReleased;
        return { kind: "verify", expectedPreviousSessionId: bindingSessionId };
      },
      adopt: async (_expectedPreviousSessionId, assertCurrent) => {
        assertCurrent();
        bindingSessionId = target.sessionId;
        return "adopted";
      },
      reclaim: async (_expectedPreviousSessionId, assertCurrent) => {
        assertCurrent();
        throw new Error("Stale reclaim is disabled");
      },
    };
    await upsertSessionEntryCore(scope(), { sessionId: previous.sessionId, updatedAt: 1 });
    await patchSessionEntryCore(scope(), () => ({ sessionId: target.sessionId }));
    const outcome = reclaimNativeSessionGeneration({
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
      reclaimNativeSessionGeneration({
        target: next,
        storePath,
        generation,
        reclaimStale: false,
        createSupersededError,
      }),
    ).resolves.toBe(false);
  });
});
