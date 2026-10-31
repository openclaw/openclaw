import type { InternalToolBatchCall } from "@openclaw/agent-core";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { takeInternalToolBatchLifecycle } from "../../../../packages/agent-core/src/internal-hooks.js";
import { markCodeModeControlTool } from "../../code-mode-control-tools.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";

const mocks = vi.hoisted(() => ({
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
import { createToolLoopBatchAdmission } from "./tool-loop-recovery.js";

function batch(id: string, args: Record<string, unknown>, timestamp: number) {
  const tool = markCodeModeControlTool(createStubTool("exec"));
  return {
    toolLoopRecoveryState: { criticalToolLoopSeen: false },
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
  for (const [index, alias] of ["code", "command"].entries()) {
    const toolCallId = `${alias}-alias`;
    const result = expectDefined(
      await admission(batch(toolCallId, { [alias]: "return 1;" }, index + 1)),
      "admission result",
    );
    const lifecycle = expectDefined(takeInternalToolBatchLifecycle(result), "batch lifecycle");
    lifecycle.commitReadyCalls?.([
      { toolCallId, args: { code: "return 1;", command: "return 1;" } },
    ]);
    lifecycle.releaseSkippedCalls?.([]);
  }

  const admittedArgs = mocks.admitToolCallBatch.mock.calls.map(([calls]) => calls[0]?.args);
  expect(admittedArgs).toEqual([
    { code: "return 1;", command: "return 1;" },
    { command: "return 1;", code: "return 1;" },
  ]);
  expect(mocks.committedArgs).toEqual(admittedArgs);
  expect(mocks.releasedIds).toEqual([[], []]);
});
