import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getAcpSessionResetControls } from "./manager.reset-controls.js";
import {
  baseCfg,
  expectCalledWith,
  extractRuntimeOptionsFromUpserts,
  installAcpSessionManagerTestLifecycle,
  managerFixture,
  mockMutableSession,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

const sessionKey = "agent:codex:acp:initialization";
const target = { cfg: baseCfg, sessionKey };
const input = { ...target, agent: "codex", mode: "persistent" as const };

function fixture() {
  const { runtimeState, manager, run } = managerFixture(sessionKey);
  const state: { currentMeta: SessionAcpMeta | undefined } = { currentMeta: undefined };
  mockMutableSession(sessionKey, state);
  return { ...runtimeState, state, manager, run };
}

installAcpSessionManagerTestLifecycle();

it("persists accepted runtime options while omitting dropped inherited thinking", async () => {
  const f = fixture();
  f.ensureSession.mockResolvedValueOnce({
    sessionKey,
    backend: "acpx",
    runtimeSessionName: "codex",
    appliedThinking: { kind: "dropped" },
  });
  const accepted = { model: "openai/gpt-5.4", cwd: "/workspace/from-runtime-options" };
  await f.manager.initializeSession({
    ...input,
    runtimeOptions: { ...accepted, thinking: "max" },
    thinkingExplicit: false,
  });
  expectCalledWith(f.ensureSession, {
    sessionKey,
    ...accepted,
    thinking: "max",
    thinkingExplicit: false,
  });
  expect(extractRuntimeOptionsFromUpserts()).toEqual([accepted]);
});

it("does not let reset-superseded initialization republish a stale runtime handle", async () => {
  const f = fixture();
  const entered = createDeferred();
  const release = createDeferred();
  f.ensureSession.mockImplementation(async () => {
    const callNumber = f.ensureSession.mock.calls.length;
    if (callNumber === 1) {
      entered.resolve();
      await release.promise;
    }
    return {
      sessionKey,
      backend: "acpx",
      runtimeSessionName: `runtime-${callNumber}`,
      backendSessionId: `backend-${callNumber}`,
    };
  });
  const stale = f.manager.initializeSession(input);
  const rejected = expect(stale).rejects.toMatchObject({
    code: "ACP_SESSION_INIT_FAILED",
    detailCode: "SESSION_ACTOR_SUPERSEDED",
  });
  await entered.promise;
  await getAcpSessionResetControls(f.manager).forceDiscardSessionRuntime({
    ...target,
    reason: "session-reset",
  });
  const fresh = await f.manager.initializeSession(input);
  expect(fresh.handle.runtimeSessionName).toBe("runtime-2");
  release.resolve();
  await rejected;
  expect(f.state.currentMeta?.runtimeSessionName).toBe("runtime-2");
  expect(f.close).toHaveBeenCalledWith({
    handle: expect.objectContaining({ runtimeSessionName: "runtime-1" }),
    reason: "session-actor-superseded",
    discardPersistentState: true,
  });
  await f.run({ text: "follow-up", requestId: "follow-up" });
  expect(f.ensureSession).toHaveBeenCalledTimes(2);
  expectCalledWith(f.runTurn, {
    handle: expect.objectContaining({ runtimeSessionName: "runtime-2" }),
  });
});
