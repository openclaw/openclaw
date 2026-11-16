import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  installSessionPlacementAdmissionProvider,
  withRequiredSessionPlacement,
  withLocalSessionPlacementTurnSettlement,
  withSessionPlacementTurnAdmission,
  type SessionPlacementAdmissionProvider,
} from "./session-placement-admission.js";

const state = vi.hoisted(() => ({ config: {} as OpenClawConfig }));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: () => state.config,
}));
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
const noop = async () => undefined;
const localResult = async () => ({ meta: { durationMs: 1 } });
const install = (
  withRequiredSession?: SessionPlacementAdmissionProvider["withRequiredSession"],
  overrides: Partial<SessionPlacementAdmissionProvider> = {},
) => {
  uninstall = installSessionPlacementAdmissionProvider({
    withRequiredSession,
    assertCompactionSuccessorAllowed: () => {},
    executeLocalTurn: async (_claim, run) => await run(),
    executeTurn: async (_claim, _turn, run) => await run(),
    ...overrides,
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
    await expect(withRequiredSessionPlacement(identity, {}, noop)).rejects.toThrow(
      "available Gateway placement owner",
    );
    let preparations = 0;
    install(async (_identity, task) => {
      preparations += 1;
      return await task(() => {});
    });
    await expect(
      withRequiredSessionPlacement({ sessionId: "helper", agentId: "main" }, {}, noop),
    ).rejects.toThrow("sessionless model helpers");
    expect(preparations).toBe(0);
  });

  it.each(["no provider", "local provider"])("never runs a local turn with %s", async (mode) => {
    if (mode === "local provider") {
      install();
    }
    const run = vi.fn(localResult);
    await expect(withSessionPlacementTurnAdmission(turn, turn, run)).rejects.toThrow(
      "Gateway execution is disabled",
    );
    await expect(withLocalSessionPlacementTurnSettlement(turn, run)).rejects.toThrow(
      "Local CLI execution is disabled",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["provider", "caller"])(
    "rechecks the exact %s after awaited preparation",
    async (owner) => {
      const started = createDeferredCore();
      const finish = createDeferredCore();
      let callerCurrent = true;
      const message = `${owner === "provider" ? "session placement owner" : "caller"} changed during required worker preparation`;
      const assertCaller = () => {
        if (!callerCurrent) {
          throw new Error(message);
        }
      };
      install(async (_identity, task, assertCurrent) => {
        assertCurrent?.();
        started.resolve();
        await finish.promise;
        return await task(() => assertCurrent?.());
      });
      const pending = withRequiredSessionPlacement(
        identity,
        owner === "caller" ? { assertCurrent: assertCaller } : {},
        noop,
      );
      const outcome = pending.catch((error: unknown) => error);
      await started.promise;
      if (owner === "provider") {
        uninstall?.();
      } else {
        callerCurrent = false;
      }
      finish.resolve();
      expect(await outcome).toMatchObject({ message });
    },
  );

  it("rejects a local CLI task when mandatory placement is enabled during admission", async () => {
    state.config = {};
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const run = vi.fn(localResult);
    install(undefined, {
      executeLocalTurn: async (_claim, runLocal) => {
        entered.resolve();
        await resume.promise;
        return await runLocal();
      },
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

  it("retains one owner admission across nested execution and fences it after release", async () => {
    let released = false;
    let current = true;
    let preparations = 0;
    install(async (_identity, task) => {
      preparations += 1;
      try {
        return await task(() => {
          if (released || !current) {
            throw new Error("required placement authority ended");
          }
        });
      } finally {
        released = true;
      }
    });
    let retainedUse: (() => Promise<void>) | undefined;
    await withRequiredSessionPlacement(identity, {}, async () => {
      await withRequiredSessionPlacement(identity, {}, noop);
      expect(released).toBe(false);
      current = false;
      await expect(withRequiredSessionPlacement(identity, {}, noop)).rejects.toThrow(
        "required placement authority ended",
      );
      current = true;
      // Async work can retain the scope after the awaited turn ends; it cannot retain authority.
      const deferred = createDeferredCore();
      retainedUse = () => {
        deferred.resolve();
        return outcome;
      };
      const outcome = (async () => {
        await deferred.promise;
        await withRequiredSessionPlacement(identity, {}, noop);
      })();
    });
    expect(preparations).toBe(1);
    expect(released).toBe(true);
    await expect(retainedUse!()).rejects.toThrow("required placement authority ended");
  });

  it("preserves standalone local execution when the requirement is absent", async () => {
    state.config = {};
    await expect(
      withRequiredSessionPlacement({ sessionId: "helper" }, {}, noop),
    ).resolves.toBeUndefined();
    const result = { meta: { durationMs: 1 } };
    await expect(withSessionPlacementTurnAdmission(turn, turn, async () => result)).resolves.toBe(
      result,
    );
  });
});
