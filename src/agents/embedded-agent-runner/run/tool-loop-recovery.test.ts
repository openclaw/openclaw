import type { InternalToolBatchCall } from "@openclaw/agent-core";
import { expect, it, vi } from "vitest";
import { markCodeModeControlTool } from "../../code-mode-control-tools.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";

const mocks = vi.hoisted(() => ({
  attachedLifecycles: [] as Array<{
    commitReadyCalls: (calls: readonly { toolCallId: string; args: unknown }[]) => void;
    releaseSkippedCalls: (ids: readonly string[]) => void;
  }>,
  committedArgs: [] as unknown[],
  releasedIds: [] as string[][],
  admitToolCallBatch: vi.fn(async (_calls: InternalToolBatchCall[]) => ({
    commitReadyCalls(readyCalls: readonly { toolCallId: string; args: unknown }[]) {
      mocks.committedArgs.push(...readyCalls.map((call) => call.args));
    },
    releaseSkippedCalls(ids: readonly string[]) {
      mocks.releasedIds.push([...ids]);
    },
  })),
}));

vi.mock("../../tool-loop-admission.js", () => ({
  admitToolCallBatch: mocks.admitToolCallBatch,
}));
vi.mock("../../runtime/internal-hooks.js", () => ({
  attachInternalToolBatchLifecycle: (
    result: object,
    lifecycle: (typeof mocks.attachedLifecycles)[number],
  ) => {
    mocks.attachedLifecycles.push(lifecycle);
    return result;
  },
}));

import { createToolLoopBatchAdmission } from "./tool-loop-recovery.js";

function batch(id: string, args: Record<string, unknown>, timestamp: number) {
  const tool = markCodeModeControlTool(createStubTool("exec"));
  return {
    assistantMessage: makeAgentAssistantMessage({
      content: [],
      provider: "test",
      model: "test",
      stopReason: "toolUse",
      timestamp,
    }),
    calls: [
      {
        toolCall: { type: "toolCall", id, name: "exec", arguments: args },
        args,
        tool,
      } satisfies InternalToolBatchCall,
    ],
    context: { systemPrompt: "", messages: [] },
  };
}

it("canonicalizes equivalent Code Mode exec aliases before loop detection", async () => {
  const admission = createToolLoopBatchAdmission({
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    runId: "run-1",
    loopDetection: { enabled: true },
  });
  const results = [];
  for (const [index, alias] of ["code", "command"].entries()) {
    const toolCallId = `${alias}-alias`;
    results.push(await admission(batch(toolCallId, { [alias]: "return 1;" }, index + 1)));
    const lifecycle = mocks.attachedLifecycles[index];
    lifecycle?.commitReadyCalls([
      { toolCallId, args: { code: "return 1;", command: "return 1;" } },
    ]);
    lifecycle?.releaseSkippedCalls([]);
  }

  const admittedArgs = mocks.admitToolCallBatch.mock.calls.map(([calls]) => calls[0]?.args);
  expect(admittedArgs).toEqual([
    { code: "return 1;", command: "return 1;" },
    { command: "return 1;", code: "return 1;" },
  ]);
  expect(mocks.committedArgs).toEqual(admittedArgs);
  expect(mocks.releasedIds).toEqual([[], []]);
  expect(results).toEqual([{}, {}]);
  expect(mocks.attachedLifecycles[0]?.commitReadyCalls).not.toBe(
    mocks.attachedLifecycles[1]?.commitReadyCalls,
  );
  expect(mocks.attachedLifecycles).toHaveLength(2);
});
