import { realpath } from "node:fs/promises";
import {
  onAgentEvent,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { expect, it, vi, type Mock } from "vitest";
import { createMuseAgentHarness, type MuseHarnessOptions } from "./harness.js";

export function registerMuseLifecycleTests({
  setup,
  getWorkspace,
  fixture,
  writes,
  terminal,
}: {
  setup: () => {
    harness: ReturnType<typeof createMuseAgentHarness>;
    params: AgentHarnessAttemptParamsV2;
    events: Array<{ stream: string; data: Record<string, unknown> }>;
    sessionStore: MuseHarnessOptions["sessionStore"];
  };
  getWorkspace: () => string;
  fixture: string;
  writes: { append: Mock };
  terminal: (result: AgentHarnessAttemptResult) => { kind: string };
}) {
  it("streams reasoning and text, journals native tool pairs, and resumes after restart", async () => {
    const workspace = getWorkspace();
    const first = setup();
    const prepareContinuationRetryCount = vi.fn();
    first.params.hostCapabilities = {
      ...first.params.hostCapabilities,
      prepareContinuationRetryCount,
    };
    const globalEvents: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const unsubscribe = onAgentEvent((event) => void globalEvents.push(event));
    try {
      const result = await first.harness.runAttempt({ ...first.params, prompt: "tool" });
      expect(prepareContinuationRetryCount).toHaveBeenCalledExactlyOnceWith({
        cwd: await realpath(workspace),
      });
      expect(terminal(result).kind).toBe("ok");
      expect(result.assistantTexts).toEqual(["started: hello"]);
      for (const events of [first.events, globalEvents]) {
        expect(
          events
            .filter((event) => event.stream === "assistant")
            .map((event) => event.data.delta)
            .join(""),
        ).toBe("started: hello");
      }
      expect(globalEvents.at(0)?.data.phase).toBe("start");
      expect(globalEvents.at(-1)?.data.phase).toBe("end");
      expect(result.messagesSnapshot.map((message) => message.role)).toEqual([
        "assistant",
        "assistant",
        "toolResult",
        "assistant",
      ]);
      expect(result.toolMetas).toEqual([{ toolName: "read_file" }]);
      expect(writes.append).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              message: expect.objectContaining({ role: "toolResult", toolCallId: "call-1" }),
            }),
          ]),
        }),
      );
    } finally {
      unsubscribe();
      await first.harness.dispose?.();
    }
    const resumed = createMuseAgentHarness({
      binaryPath: fixture,
      sessionStore: first.sessionStore,
    });
    try {
      const result = await resumed.runAttempt(first.params);
      expect(terminal(result).kind).toBe("ok");
      expect(result.assistantTexts).toEqual(["resumed: hello"]);
      const changed = await resumed.runAttempt({ ...first.params, modelId: "muse-other" });
      expect(changed.assistantTexts).toEqual(["started: hello"]);
    } finally {
      await resumed.dispose?.();
    }
  });
}
