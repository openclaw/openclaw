import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  installSessionPlacementAdmissionProvider,
  prepareRequiredSessionPlacement,
  withLocalSessionPlacementTurnSettlement,
  withSessionPlacementTurnAdmission,
  type SessionPlacementAdmissionProvider,
} from "./session-placement-admission.js";

const state = vi.hoisted(() => ({ config: {} as OpenClawConfig }));
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => state.config }));
const identity = {
  sessionId: "required-session",
  sessionKey: "agent:main:required",
  agentId: "main",
};
const turn = {
  ...identity,
  runId: "required-run",
  sessionFile: identity.sessionKey,
  workspaceDir: "/workspace",
  prompt: "test",
  timeoutMs: 1000,
};
let uninstall: (() => void) | undefined;
const install = (
  prepareRequiredSession?: SessionPlacementAdmissionProvider["prepareRequiredSession"],
) => {
  uninstall = installSessionPlacementAdmissionProvider({
    prepareRequiredSession,
    assertCompactionSuccessorAllowed: () => {},
    executeLocalTurn: async (_claim, run) => await run(),
    executeTurn: async (_claim, _turn, run) => await run(),
  });
};
beforeEach(() => {
  state.config = { cloudWorkers: { requiredProfile: "remote" } };
});
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  state.config = {};
});

describe("required worker run admission", () => {
  it("rejects unavailable ownership and sessionless helpers without creating a session", async () => {
    await expect(prepareRequiredSessionPlacement(identity)).rejects.toThrow(
      "available Gateway placement owner",
    );
    const prepare = vi.fn(async () => {});
    install(prepare);
    await expect(
      prepareRequiredSessionPlacement({ sessionId: "helper", agentId: "main" }),
    ).rejects.toThrow("sessionless model helpers");
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each(["no provider", "local provider"])("never runs a local turn with %s", async (mode) => {
    if (mode === "local provider") {
      install();
    }
    const run = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    await expect(withSessionPlacementTurnAdmission(turn, turn, run)).rejects.toThrow(
      "Gateway execution is disabled",
    );
    await expect(withLocalSessionPlacementTurnSettlement(turn, run)).rejects.toThrow(
      "Local CLI execution is disabled",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("rechecks the exact provider and caller after awaited preparation", async () => {
    const started = createDeferredCore();
    const finish = createDeferredCore();
    const assertCaller = vi.fn();
    install(async (_identity, assertCurrent) => {
      assertCurrent?.();
      started.resolve();
      await finish.promise;
    });
    const pending = prepareRequiredSessionPlacement(identity, { assertCurrent: assertCaller });
    const outcome = pending.catch((error: unknown) => error);
    await started.promise;
    uninstall?.();
    finish.resolve();
    expect(await outcome).toMatchObject({
      message: "session placement owner changed during required worker preparation",
    });
    expect(assertCaller).toHaveBeenCalled();
  });

  it("rejects a local CLI task when mandatory placement is enabled during admission", async () => {
    state.config = {};
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const run = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    uninstall = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed: () => {},
      executeLocalTurn: async (_claim, runLocal) => {
        entered.resolve();
        await resume.promise;
        return await runLocal();
      },
      executeTurn: async (_claim, _params, runLocal) => await runLocal(),
    });
    const pending = withLocalSessionPlacementTurnSettlement(turn, run);
    const outcome = pending.catch((error: unknown) => error);
    try {
      await entered.promise;
      state.config = { cloudWorkers: { requiredProfile: "remote" } };
    } finally {
      resume.resolve();
    }
    expect(await outcome).toMatchObject({
      message: expect.stringContaining("Local CLI execution is disabled"),
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("preserves standalone local execution when the requirement is absent", async () => {
    state.config = {};
    await expect(prepareRequiredSessionPlacement({ sessionId: "helper" })).resolves.toBeUndefined();
    const result = { meta: { durationMs: 1 } };
    await expect(withSessionPlacementTurnAdmission(turn, turn, async () => result)).resolves.toBe(
      result,
    );
  });
});
