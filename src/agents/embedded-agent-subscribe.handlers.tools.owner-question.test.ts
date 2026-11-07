/** A bot sender's ask_user prompt reaches the agent's owner, not the bot's conversation. */
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createGenericTargetTestPlugin,
  createTargetsTestRegistry,
} from "../infra/outbound/targets.test-helpers.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  activateAskUserPrompt,
  createBasicAskUserArgs,
  finishPendingAskUserPrompts,
} from "./embedded-agent-subscribe.handlers.tools.ask-user.test-support.js";
import { handleToolExecutionStart } from "./embedded-agent-subscribe.handlers.tools.start.js";
import { createTestContext } from "./embedded-agent-subscribe.handlers.tools.test-support.js";
import { cancelAskUserPromptDelivery } from "./tools/ask-user-tool.js";

const sendDurableMessageBatchCore = vi.hoisted(() => vi.fn());

vi.mock("../channels/message/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channels/message/runtime.js")>()),
  sendDurableMessageBatchCore,
}));

// mock-isolation: Keep prompt-readiness RPCs on the fixture, never the operator Gateway.
vi.mock("./harness/gateway-question-dispatch.runtime.js", () => ({
  callGatewayTool: async (method: string) => {
    if (method !== "question.list") {
      throw new Error(`Unexpected question readiness RPC: ${method}`);
    }
    return { questions: [] };
  },
}));

const registrySnapshot = captureActivePluginRegistrySnapshot();
const cfg: OpenClawConfig = {
  commands: { ownerAllowFrom: ["alpha:user:owner"] },
  channels: { alpha: {} },
  gateway: { publicOrigin: "https://ops.example.test" },
};

beforeEach(() => {
  sendDurableMessageBatchCore.mockReset().mockResolvedValue({
    status: "sent",
    results: [],
    receipt: { platformMessageIds: ["m1"], parts: [], sentAt: 1 },
  });
  setRuntimeConfigSnapshot(cfg);
  setActivePluginRegistry(
    createTargetsTestRegistry([
      { ...createGenericTargetTestPlugin("alpha"), agentPrompt: { questionInputMode: "buttons" } },
    ]),
  );
});
afterEach(async () => {
  await finishPendingAskUserPrompts();
  clearRuntimeConfigSnapshot();
  restoreActivePluginRegistrySnapshot(registrySnapshot);
});

it("sends a bot sender's ask_user prompt to the owner instead of its conversation", async () => {
  const { ctx } = createTestContext();
  const onToolResult = vi.fn();
  ctx.params.onToolResult = onToolResult;
  ctx.params.senderIsBot = true;
  const toolCallId = "ask-from-bot";
  const args = createBasicAskUserArgs();
  onTestFinished(() =>
    cancelAskUserPromptDelivery(
      toolCallId,
      ctx.params.sessionKey,
      ctx.params.runId,
      ctx.params.agentId,
    ),
  );

  await handleToolExecutionStart(ctx, {
    type: "tool_execution_start",
    toolName: "ask_user",
    toolCallId,
    args,
  });
  const { questionId } = await activateAskUserPrompt(toolCallId, args);
  await vi.waitFor(() => expect(sendDurableMessageBatchCore).toHaveBeenCalledOnce());

  expect(sendDurableMessageBatchCore).toHaveBeenCalledWith(
    expect.objectContaining({ channel: "alpha", to: expect.stringMatching(/user:owner$/) }),
  );
  expect(sendDurableMessageBatchCore.mock.calls[0]?.[0].payloads[0].text).toContain(
    `https://ops.example.test/ask/${questionId}`,
  );
  expect(onToolResult).not.toHaveBeenCalled();
});
