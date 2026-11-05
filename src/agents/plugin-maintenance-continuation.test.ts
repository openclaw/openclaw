import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createPluginForceReload } from "../gateway/server-plugin-force-reload.js";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import {
  getCurrentSessionControllerOwner,
  withSessionControllerOwner,
  withSessionControllerSource,
} from "../sessions/session-controller.context.js";
import { captureSessionControllerEffects } from "../sessions/session-controller.lifecycle-work.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { tryClaimSessionControllerTask } from "../sessions/session-controller.mailbox-task.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { captureSessionControllerStop, stopSession } from "../sessions/session-controller.stop.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const mocks = vi.hoisted(() => ({
  captureAuthority: vi.fn(),
  captureTarget: vi.fn(),
  enqueue: vi.fn(),
  readEntry: vi.fn(),
}));
// mock-isolation: Supply a revocable admitted capability without a live Gateway client registry.
vi.mock("../gateway/server-plugin-in-process-authority.js", () => ({
  captureOperatorToolGatewayContinuationContextInternal: mocks.captureAuthority,
}));
// mock-isolation: The target is an admitted synthetic incarnation, not a database session.
vi.mock("../auto-reply/reply/session-event-target.js", () => ({
  captureSessionEventTargetForHost: mocks.captureTarget,
}));
// mock-isolation: Inspect the host delivery receipt without dispatching another real agent turn.
vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  enqueueSessionEventForHost: mocks.enqueue,
}));
// mock-isolation: Exercise incognito policy with an in-memory admitted session entry.
vi.mock("../config/sessions/session-entry-read-runtime.js", () => ({
  withSessionEntryReadOnlyInWorker: mocks.readEntry,
}));
import {
  capturePluginMaintenanceContinuation,
  registerPluginMaintenanceContinuation,
} from "./plugin-maintenance-continuation.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  vi.clearAllMocks();
});

function fixture() {
  const sessionKey = "agent:main:maintenance-" + randomUUID();
  const sessionId = randomUUID();
  const target = captureSessionTarget({
    storeScope: "/synthetic/maintenance/sessions.json",
    sessionKey,
    incarnation: sessionId,
    agentId: "main",
  });
  const operation = createReplyOperation({
    sessionKey,
    sessionId,
    agentId: "main",
    target,
    resetTriggered: false,
  });
  const source = reserveSessionControllerSource(sessionKey, {
    target,
    protocolRunId: randomUUID(),
    policy: { mode: "followup" },
  });
  source.sourceAdapter = { requester: { connectionId: "alice-original" } };
  const authority = new AsyncLocalStorage<string>();
  const current = vi.fn();
  const release = vi.fn();
  mocks.captureAuthority.mockImplementation(async () => {
    expect(authority.getStore()).toBe("alice");
    return {
      assertCurrent: current,
      release,
      signal: new AbortController().signal,
      runWithRequester: async (run: () => unknown) => run(),
    };
  });
  mocks.captureTarget.mockResolvedValue({
    agentId: "main",
    sessionKey,
    sessionId,
    storePath: target.storeScope,
    generation: "generation",
  });
  mocks.readEntry.mockImplementation(async (_scope, assertCurrent, run) => {
    assertCurrent();
    return run({ ok: true, value: {} });
  });
  mocks.enqueue.mockReturnValue({
    id: "accepted",
    accepted: Promise.resolve({ ok: true }),
    settled: Promise.resolve({ status: "completed" }),
  });
  const unregister = authority.run("alice", () =>
    withSessionControllerSource(source, () =>
      withSessionControllerOwner(operation, () => {
        expect(getCurrentSessionControllerOwner()).toBe(operation);
        return registerPluginMaintenanceContinuation({ agentId: "main", sessionKey, sessionId });
      }),
    ),
  );
  cleanups.push(() => {
    unregister();
    operation.complete();
    retireSessionControllerInput(source);
  });
  return { sessionKey, sessionId, target, source, operation, authority, current, release };
}

it("captures the exact original native owner, fences successors, preserves FIFO, and waits for physical cleanup before one accepted continuation", async () => {
  const f = fixture();
  expect(capturePluginMaintenanceContinuation({})).toBeUndefined();
  const physical = createDeferredCore();
  f.operation.registerExecutionCleanup(() => physical.promise);
  const captured = await f.authority.run("admin", () =>
    capturePluginMaintenanceContinuation(f.operation),
  );
  expect(captured).toBeDefined();
  cleanups.push(() => captured?.cancel());
  expect(await capturePluginMaintenanceContinuation(f.operation)).toBe(captured);
  const queued = reserveSessionControllerSource(f.sessionKey, {
    target: f.target,
    protocolRunId: "queued",
    policy: { mode: "followup" },
  });
  cleanups.push(() => retireSessionControllerInput(queued));
  await captured!.interrupt(() => {});
  expect(f.operation.abortSignal.aborted).toBe(true);
  expect(queued.abortSignal.aborted).toBe(false);
  expect(queued.mailbox.entries.indexOf(queued)).toBeGreaterThanOrEqual(0);
  const finish = captured!.finish({ ok: true, pluginIds: ["example"] }, true, async () => {});
  f.operation.complete();
  retireSessionControllerInput(f.source);
  await Promise.resolve();
  await finish;
  expect(mocks.enqueue).not.toHaveBeenCalled();
  physical.resolve(undefined);
  await captured!.settled;
  await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
  await captured!.finish({ ok: true, pluginIds: ["example"] }, true, async () => {});
  expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  expect(mocks.enqueue.mock.calls[0]?.[0]).toContain("Preserve completed tool results");
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(1));
});

it("keeps Stop custody after the RPC input retires and never resumes a stopped or completed turn", async () => {
  const f = fixture();
  const captured = await capturePluginMaintenanceContinuation(f.operation);
  cleanups.push(() => captured?.cancel());
  await captured!.interrupt(() => {});
  f.operation.complete();
  retireSessionControllerInput(f.source);
  await captured!.settled;
  const effects = captureSessionControllerEffects({ target: f.target });
  expect(effects).toHaveLength(1);
  expect(effects[0]?.run?.abortAuthority?.requester?.connectionId).toBe("alice-original");
  await stopSession({
    capture: captureSessionControllerStop({ effects }),
    source: "client-session",
    hookContext: { sessionKey: f.sessionKey, sessionId: f.sessionId },
  }).completed;
  await captured!.finish({ ok: true, pluginIds: ["example"] }, true, async () => {});
  expect(mocks.enqueue).not.toHaveBeenCalled();
  const completed = fixture();
  const saved = await capturePluginMaintenanceContinuation(completed.operation);
  completed.operation.complete();
  retireSessionControllerInput(completed.source);
  await saved!.interrupt(() => {});
  await saved!.finish({ ok: true, pluginIds: ["example"] }, true, async () => {});
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it("keeps unhealthy runtime successors fenced without waiting indefinitely for cleanup", async () => {
  const f = fixture();
  const physical = createDeferredCore();
  f.operation.registerExecutionCleanup(() => physical.promise);
  const captured = await capturePluginMaintenanceContinuation(f.operation);
  cleanups.push(() => {
    physical.resolve(undefined);
    captured?.cancel();
  });
  await captured!.interrupt(() => {});
  f.operation.complete();
  retireSessionControllerInput(f.source);
  await captured!.finish(
    {
      ok: false,
      pluginIds: ["example"],
      error: "restoration failed",
      replacement: { kind: "failed", committed: false, unavailablePluginIds: ["example"] },
    },
    false,
    async () => {},
  );
  expect(captureSessionControllerEffects({ target: f.target })).toHaveLength(1);
  expect(mocks.enqueue).not.toHaveBeenCalled();
  physical.resolve(undefined);
  await captured!.settled;
  expect(captureSessionControllerEffects({ target: f.target })).toHaveLength(1);
  expect(mocks.enqueue).not.toHaveBeenCalled();
  captured!.cancel();
  expect(captureSessionControllerEffects({ target: f.target })).toHaveLength(0);
});

it("rejects incognito custody before interrupting its admitted work", async () => {
  const f = fixture();
  mocks.readEntry.mockImplementationOnce(
    async (_input, _assertCurrent, read) => await read({ ok: true, value: { incognito: true } }),
  );
  await expect(capturePluginMaintenanceContinuation(f.operation)).rejects.toThrow("Incognito");
  expect(f.operation.abortSignal.aborted).toBe(false);
  expect(captureSessionControllerEffects({ target: f.target })).toHaveLength(0);
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it("holds a timed-out continuation until actual plugin cleanup, not bridge settlement", async () => {
  const f = fixture();
  const captured = await capturePluginMaintenanceContinuation(f.operation);
  const physical = createDeferredCore();
  const settlePluginWork = vi.fn(() => physical.promise);
  await captured!.interrupt(() => {});
  f.operation.complete();
  retireSessionControllerInput(f.source);
  await captured!.settled;
  await captured!.finish(
    {
      ok: false,
      pluginIds: ["example"],
      error: "drain timed out",
      replacement: { kind: "restored", committed: false, unavailablePluginIds: [] },
    },
    true,
    settlePluginWork,
  );
  await vi.waitFor(() => expect(settlePluginWork).toHaveBeenCalledOnce());
  expect(mocks.enqueue).not.toHaveBeenCalled();
  physical.resolve();
  await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
});

it("keeps an internal turn private despite the session's recorded external route", async () => {
  const f = await withGatewayToolCallerIdentity(
    { agentId: "main", sessionKey: "agent:main:private", turnSourceChannel: "webchat" },
    () => fixture(),
  );
  mocks.captureTarget.mockResolvedValue({
    agentId: "main",
    sessionKey: f.sessionKey,
    sessionId: f.sessionId,
    storePath: f.target.storeScope,
    generation: "generation",
    deliveryContext: { channel: "telegram", to: "external-recipient" },
  });
  const captured = await capturePluginMaintenanceContinuation(f.operation);
  await captured!.interrupt(() => {});
  f.operation.complete();
  retireSessionControllerInput(f.source);
  await captured!.finish({ ok: true, pluginIds: ["example"] }, true, async () => {});
  await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
  expect(mocks.enqueue.mock.calls[0]?.[1]).toMatchObject({
    deliveryContext: { channel: "webchat" },
  });
});

it("revalidates the maintenance principal before touching another requester's execution", async () => {
  const f = fixture();
  const captured = await capturePluginMaintenanceContinuation(f.operation);
  const denied = () => {
    throw new Error("maintenance administrator revoked");
  };
  await expect(captured!.interrupt(denied)).rejects.toThrow("maintenance administrator revoked");
  expect(f.operation.abortSignal.aborted).toBe(false);
  expect(f.source.abortSignal.aborted).toBe(false);
  expect(mocks.enqueue).not.toHaveBeenCalled();
  captured!.cancel();
});

it.each([
  ["failed", true, false, "", "activate"],
  ["failed", true, false, "", "dispose"],
  ["failed", false, false, "", "activate"],
  ["applied", true, true, "completed", "dispose"],
  ["restored", false, true, "rolled back", "activate"],
  ["unchanged", false, true, "not applied", "prepare"],
] as const)(
  "settled %s committed=%s healthy=%s wording=%s phase=%s",
  async (kind, committed, healthy, message, phase) => {
    const f = fixture();
    const captured = (await capturePluginMaintenanceContinuation(f.operation))!;
    const instance = new PluginInstance("example");
    const releaseWork = instance.retainWork("prepared-generation-lease", f.operation);
    f.operation.abortSignal.addEventListener(
      "abort",
      () => {
        releaseWork();
        f.operation.complete();
        retireSessionControllerInput(f.source);
      },
      { once: true },
    );
    const coordinator = createPluginForceReload(
      () => {},
      async () => captured,
    );
    const queued = reserveSessionControllerSource(f.sessionKey, {
      target: f.target,
      policy: { mode: "followup" },
    });
    cleanups.push(() => {
      captured.cancel();
      retireSessionControllerInput(queued);
      releaseWork();
    });
    await coordinator.drain([instance], new AbortController().signal);
    const error = new PluginRuntimeApplicationError(`${kind} operation failed`, {
      operationId: "committed-activation",
      generation: 2,
      pluginIds: ["example"],
      phase,
      committed,
    });
    const completion = coordinator.complete(
      kind === "applied" ? Promise.resolve("applied") : Promise.reject(error),
      ["example"],
      Promise.resolve({
        kind,
        committed,
        unavailablePluginIds: kind === "applied" ? ["example"] : [],
      }),
    );
    if (kind === "applied") {
      await expect(completion).resolves.toBe("applied");
    } else {
      await expect(completion).rejects.toBe(error);
    }
    await setImmediate();
    if (healthy) {
      expect(mocks.enqueue).toHaveBeenCalledOnce();
      expect(mocks.enqueue.mock.calls[0]?.[0]).toContain(`Plugin maintenance ${message} for`);
    } else {
      expect(mocks.enqueue).not.toHaveBeenCalled();
      expect(tryClaimSessionControllerTask(queued)).toBeUndefined();
    }
  },
);
