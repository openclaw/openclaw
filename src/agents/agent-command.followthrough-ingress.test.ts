import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  compactionTestState as state,
  makeCompactionResult,
  registerAgentCommandCompactionTestHooks,
} from "./agent-command.compaction.test-support.js";
import { buildCommandAttemptToolContext } from "./command/attempt-tool-context.js";
import { createMessageTool } from "./tools/message-tool-execution.js";

registerAgentCommandCompactionTestHooks();
it("preserves the private source route from new explicit-session ingress through progress and work", async () => {
  const { agentCommandFromIngress } = await import("./agent-command.js");
  let exercised = false;
  state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
    const context = buildCommandAttemptToolContext(params);
    expect(params.sessionKey).toBe("agent:main:explicit:followthrough-ingress");
    expect(context.messageProvider).toBe("webchat");
    expect(params.opts.sourceReplyDeliveryMode).toBe("message_tool_only");
    setRuntimeConfigSnapshot(params.cfg);
    const message = createMessageTool({
      config: params.cfg,
      agentId: params.sessionAgentId,
      agentSessionKey: params.sessionKey,
      runSessionKey: params.sessionKey,
      sessionId: params.sessionId,
      runId: params.runId,
      currentChannelProvider: context.messageProvider,
      sourceReplyDeliveryMode: params.opts.sourceReplyDeliveryMode,
      preparedMessageToolCatalog: { version: 0, channels: [], getChannel: () => undefined },
    });
    const progress = await message.execute("progress", {
      action: "send",
      message: "synthetic progress",
      final: false,
    });
    expect(progress.details).toMatchObject({
      sourceReplySink: "internal-ui",
      deliveryStatus: "sent",
    });
    const output = path.join(params.workspaceDir, "followthrough.txt");
    await fs.writeFile(output, "synthetic work after successful progress");
    expect(await fs.readFile(output, "utf8")).toBe("synthetic work after successful progress");
    const final = await message.execute("complete", {
      action: "send",
      message: "synthetic complete",
      final: true,
    });
    expect(final.details).toMatchObject({ sourceReplySink: "internal-ui", deliveryStatus: "sent" });
    exercised = true;
    return makeCompactionResult({
      sessionId: params.sessionId,
      text: "synthetic complete",
      runner: "embedded",
    });
  });
  await agentCommandFromIngress({
    agentId: "main",
    sessionId: "followthrough-ingress",
    message: "synthetic followthrough",
    model: "openai/gpt-5.5",
    thinking: "medium",
    timeout: "60",
    json: true,
    messageChannel: "webchat",
    channel: "webchat",
    sourceReplyDeliveryMode: "message_tool_only",
    allowModelOverride: true,
    cleanupBundleMcpOnRunEnd: true,
    cleanupCliLiveSessionOnRunEnd: true,
    oneShotCliRun: true,
  });
  expect(exercised).toBe(true);
});
