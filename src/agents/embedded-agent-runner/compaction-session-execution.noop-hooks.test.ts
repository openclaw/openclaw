import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { agentSessionAutomaticCompaction } from "../sessions/agent-session-compaction.js";
import { useCompactHooksSessionFixture } from "./compact.hooks.fixture.test-support.js";
import {
  createAgentSessionMock,
  hookRunner,
  loadCompactHooksHarness,
  sessionCompactImpl,
  sessionMessages,
  triggerInternalHookMock,
} from "./compact.hooks.harness.js";

const sessionKey = "agent:main:noop-hooks";
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
  hookRunner.hasHooks.mockReturnValue(true);
});

afterEach(() => configRuntime.clearRuntimeConfigSnapshot());

it.each(["heartbeat", "retention"] as const)(
  "settles a successful %s skip once without changing history or accounting",
  async (kind) => {
    if (kind === "heartbeat") {
      sessionMessages.splice(0, sessionMessages.length, {
        role: "user",
        content: "HEARTBEAT_OK",
        timestamp: 1,
      });
    } else {
      const createSession = createAgentSessionMock.getMockImplementation();
      if (!createSession) {
        throw new Error("Compaction session fixture is not initialized");
      }
      createAgentSessionMock.mockImplementationOnce(async (...args) => {
        const result = await createSession(...args);
        result.session[agentSessionAutomaticCompaction].mockResolvedValueOnce({
          status: "skipped",
          reason: "Nothing to compact (session too small)",
        });
        return result;
      });
    }
    const before = structuredClone(sessionMessages.slice(0, 2));
    const { attachCompactionAccountingRecorder } =
      await import("./run/compaction-accounting-bridge.js");
    const receipts: unknown[] = [];
    const contextEngineRuntimeContext = {};
    attachCompactionAccountingRecorder(contextEngineRuntimeContext, {
      recordCompaction: (receipt) => {
        receipts.push(receipt);
      },
    });

    const result = await compact({
      agentId: "main",
      sessionId: prepared.sessionId,
      sessionKey,
      sessionFile: sessionKey,
      sessionTarget: { agentId: "main", sessionId: prepared.sessionId, sessionKey, storePath },
      workspaceDir: prepared.workspaceDir,
      trigger: "overflow",
      contextEngineRuntimeContext,
    });

    expect(result).toMatchObject({ ok: true, compacted: false });
    expect(hookRunner.runBeforeCompaction).toHaveBeenCalledOnce();
    expect(hookRunner.runAfterCompaction).toHaveBeenCalledExactlyOnceWith(
      {
        messageCount: before.length,
        tokenCount: before.length * 10,
        compactedCount: 0,
        sessionFile: `sqlite:main:${prepared.sessionId}:${storePath}`,
      },
      expect.objectContaining({ sessionKey, sessionId: prepared.sessionId }),
    );
    expect(triggerInternalHookMock.mock.calls.map(([event]) => event)).toMatchObject([
      { action: "compact:before" },
      { action: "compact:after", context: { compactionOutcome: "skipped", compactedCount: 0 } },
    ]);
    expect((await createAgentSessionMock.mock.results[0]?.value)?.session.messages).toEqual(before);
    expect(receipts).toEqual([]);
    expect(sessionCompactImpl).not.toHaveBeenCalled();
  },
);
