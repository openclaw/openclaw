import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexNativeModelContext } from "./client-workspace-state.js";
import type { CodexAttemptActiveTurn } from "./run-attempt-active-turn.js";
import type { CodexAttemptNotificationController } from "./run-attempt-notification-controller.js";
import { beginCodexAttemptSettlement } from "./run-attempt-settlement.js";
import type { StartedCodexAttemptResources } from "./run-attempt-start.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";

// The optional native read is the boundary under test; hold it open like stalled disk I/O.
const nativeRead = vi.hoisted(() => ({
  pending: undefined as
    | undefined
    | { signal: AbortSignal; resolve: (context: CodexNativeModelContext) => void },
}));
vi.mock("./native-model-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native-model-context.js")>()),
  readCodexNativeModelContext: (_resources: unknown, signal: AbortSignal) =>
    new Promise<CodexNativeModelContext | undefined>((resolve) => {
      nativeRead.pending = { signal, resolve };
    }),
}));

afterEach(() => {
  nativeRead.pending = undefined;
});

async function flushMicrotasks() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

function settlementFixture(aborted: boolean) {
  const runAbortController = new AbortController();
  if (aborted) {
    runAbortController.abort();
  }
  const setNativeModelContext = vi.fn();
  const resources = {
    state: { thread: { threadId: "thread" } },
    prompt: {
      setNativeModelContext,
      context: {
        runtime: { connection: { params: {}, runAbortController, appServer: {} } },
        attemptTools: { toolBridge: { telemetry: {} } },
      },
    },
  } as unknown as StartedCodexAttemptResources;
  const turnRuntime = {
    state: { abortCleanup: Promise.resolve() },
    deadlines: { dispose: () => undefined },
    // An already-aborted run also has an expired settlement deadline.
    settlementExpired: aborted ? Promise.resolve() : new Promise<void>(() => {}),
  } as unknown as CodexAttemptTurnState;
  const drainNotificationQueue = vi.fn(async () => undefined);
  const activeTurn = {
    activeTurnId: "turn",
    activeProjector: {
      getPendingNativeCommands: () => new Map(),
      prepareTerminalToolResultCheckpoint: () => undefined,
      closeProjection: async () => undefined,
      settlement: { drain: async () => undefined },
    },
  } as unknown as CodexAttemptActiveTurn;
  const notifications = { drainNotificationQueue } as unknown as CodexAttemptNotificationController;
  return { resources, turnRuntime, notifications, activeTurn, setNativeModelContext };
}

describe("beginCodexAttemptSettlement", () => {
  it.each([false, true])(
    "never waits for optional native context reporting (aborted run: %s)",
    async (aborted) => {
      const fixture = settlementFixture(aborted);
      let returned = false;
      const begun = beginCodexAttemptSettlement(
        fixture.resources,
        fixture.turnRuntime,
        fixture.notifications,
        fixture.activeTurn,
      ).then((control) => {
        returned = true;
        return control;
      });
      await flushMicrotasks();
      expect(returned).toBe(true);
      expect(fixture.notifications.drainNotificationQueue).toHaveBeenCalled();

      const control = await begun;
      await control.settlement;
      const late = nativeRead.pending;
      control.closeSettlement();
      if (late) {
        // A read finishing after settlement closed must not touch the built result.
        expect(late.signal.aborted).toBe(true);
        late.resolve({ baseInstructions: "late" });
        await flushMicrotasks();
      }
      expect(fixture.setNativeModelContext).not.toHaveBeenCalled();
    },
  );

  it("applies native context that arrives while settlement is active", async () => {
    const fixture = settlementFixture(false);
    const control = await beginCodexAttemptSettlement(
      fixture.resources,
      fixture.turnRuntime,
      fixture.notifications,
      fixture.activeTurn,
    );
    nativeRead.pending?.resolve({ baseInstructions: "base" });
    await flushMicrotasks();
    control.closeSettlement();
    expect(fixture.setNativeModelContext).toHaveBeenCalledWith({ baseInstructions: "base" });
  });
});
