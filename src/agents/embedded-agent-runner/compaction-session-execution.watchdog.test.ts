import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { withSessionControllerOwner } from "../../sessions/session-controller.context.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { useCompactHooksSessionFixture } from "./compact.hooks.fixture.test-support.js";
import { loadCompactHooksHarness, sessionCompactImpl } from "./compact.hooks.harness.js";

const sessionKey = "agent:main:compaction-watchdog";
const fixture = useCompactHooksSessionFixture(sessionKey);
let compact: Awaited<
  ReturnType<typeof loadCompactHooksHarness>
>["compactEmbeddedAgentSessionDirect"];
let configRuntime: typeof import("../../config/runtime-snapshot.js");
let storePath: string;
let prepared: Awaited<ReturnType<typeof fixture.prepareSession>>;

beforeAll(async () => {
  compact = (await loadCompactHooksHarness()).compactEmbeddedAgentSessionDirect;
  configRuntime = await import("../../config/runtime-snapshot.js");
  storePath = await fixture.prepare();
});
beforeEach(async () => {
  configRuntime.setRuntimeConfigSnapshot({});
  prepared = await fixture.prepareSession();
});
afterEach(() => configRuntime.clearRuntimeConfigSnapshot());

it.each(["success", "failure"] as const)(
  "preserves the foreground watchdog across direct compaction %s",
  async (outcome) => {
    const operation = createReplyOperation({
      sessionKey,
      sessionId: prepared.sessionId,
      resetTriggered: false,
    });
    operation.setPhase("running");
    const foreground = operation.watchdog.attachAttempt({ assertCurrent() {} });
    const deadline = Date.now() + 60 * 60_000;
    foreground.setExecutionDeadline(deadline);
    const implementation = sessionCompactImpl.getMockImplementation();
    if (!implementation) {
      throw new Error("Compaction model fixture is not initialized");
    }
    sessionCompactImpl.mockImplementationOnce(async () => {
      expect(foreground.isCurrent()).toBe(true);
      if (outcome === "failure") {
        throw new Error("synthetic compaction failure");
      }
      return implementation();
    });
    try {
      const result = await withSessionControllerOwner(operation, () =>
        compact({
          agentId: "main",
          sessionId: prepared.sessionId,
          sessionKey,
          sessionFile: sessionKey,
          sessionTarget: { agentId: "main", sessionId: prepared.sessionId, sessionKey, storePath },
          workspaceDir: prepared.workspaceDir,
          trigger: "overflow",
        }),
      );
      expect(result.ok).toBe(outcome === "success");
      expect(sessionCompactImpl).toHaveBeenCalledOnce();
      expect(foreground.isCurrent()).toBe(true);
      expect(operation.watchdog.snapshot().executionDeadlineAtMs).toBe(deadline);
      const wait = foreground.beginWait({ kind: "runtime_owned", isCurrent: () => true });
      expect(operation.watchdog.snapshot().waits).toEqual([{ kind: "runtime_owned" }]);
      expect(operation.watchdog.decide(Date.now() + 6 * 60_000).action).toBe("observe");
      wait.close();
    } finally {
      operation.complete();
      await operation.ownerSettlement;
    }
  },
);
