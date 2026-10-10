import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { createOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  captureNativeSessionGenerationAuthority,
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

  it("preserves synchronous authority capture for released harness plugins", async () => {
    await upsertSessionEntryCore(scope(), { sessionId: target.sessionId, updatedAt: 1 });
    const captured = captureNativeSessionGenerationAuthority({
      target,
      storePath,
      createSupersededError,
    });
    expect(captured.state).toBe("current");
    expect(captured.assertCurrent).not.toThrow();
    expect(captured.assertHostCurrent).not.toThrow();

    await patchSessionEntryCore(scope(), () => ({ sessionId: "session-successor" }));
    expect(captured.assertCurrent).toThrow("Session generation is no longer current");
    expect(captured.assertHostCurrent).toThrow("Session generation is no longer current");
  });

  it.each(
    (["resolve", "reclaim"] as const).flatMap((entry) =>
      (["adopt", "reclaim"] as const).map((mutation) => ({ entry, mutation })),
    ),
  )("fences released $entry callbacks after an awaited $mutation", async ({ entry, mutation }) => {
    let bindingSessionId = "session-previous";
    const entered = createDeferred();
    const released = createDeferred();
    const mutate = async (assertCurrent: () => void) => {
      entered.resolve();
      await released.promise;
      assertCurrent();
      bindingSessionId = target.sessionId;
    };
    const generation: NativeSessionGenerationOperations = {
      prepareReclaim: async () => ({
        kind: "verify",
        expectedPreviousSessionId: bindingSessionId,
      }),
      adopt: async (_previous, assertCurrent) => {
        if (mutation === "reclaim") {
          return "absent";
        }
        await mutate(assertCurrent);
        return "adopted";
      },
      reclaim: async (_previous, assertCurrent) => {
        await mutate(assertCurrent);
        return true;
      },
    };
    await upsertSessionEntryCore(scope(), { sessionId: bindingSessionId, updatedAt: 1 });
    await patchSessionEntryCore(scope(), () => ({ sessionId: target.sessionId }));
    const params = { target, storePath, generation, createSupersededError };
    const outcome = (
      entry === "resolve"
        ? resolveNativeSessionBinding({
            ...params,
            reclaimStale: true,
            readBinding: () => (bindingSessionId === target.sessionId ? binding : undefined),
          })
        : reclaimNativeSessionGeneration(params)
    ).catch((error: unknown) => error);
    await entered.promise;
    await patchSessionEntryCore(scope(), () => ({ sessionId: "session-successor" }));
    released.resolve();

    expect(await outcome).toMatchObject({
      message: `Session generation is no longer current: ${target.sessionId}`,
    });
    expect(bindingSessionId).toBe("session-previous");
  });
});
