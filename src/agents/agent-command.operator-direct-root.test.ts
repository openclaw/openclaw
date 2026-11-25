/** Tests the direct chat type a local operator's root session records at creation. */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveMemoryAudienceFromEntry } from "../plugins/memory-audience.js";
import {
  agentCommand,
  compactionTestState as state,
  findCompactionSessionEntry as findStoredSessionEntry,
  makeCompactionResult as makeResult,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath as requireStorePath,
} from "./agent-command.compaction.test-support.js";
import { buildCommandAttemptToolContext } from "./command/attempt-tool-context.js";
import { createMessageTool } from "./tools/message-tool-execution.js";

// Register hooks for this file, not as a cached support-module side effect.
registerAgentCommandCompactionTestHooks();

// Runs one local command turn the way `openclaw agent exec` does: a fresh
// session id with no key, so the command creates its explicit root row.
async function runLocalRoot(operatorDirectRoot?: boolean) {
  const sessionId = randomUUID();
  let senderIsOwner: boolean | undefined;
  state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
    senderIsOwner = params.opts.senderIsOwner;
    return makeResult({ sessionId, text: "done", runner: "embedded", agentHarnessId: "openclaw" });
  });
  await agentCommand({ message: "hello", sessionId, oneShotCliRun: true, operatorDirectRoot });
  const sessionKey = `agent:main:explicit:${sessionId}`;
  const entry = findStoredSessionEntry(sessionKey);
  if (!entry) {
    throw new Error(`missing stored session ${sessionKey}`);
  }
  return { sessionKey, entry, senderIsOwner };
}

describe("agentCommand operator direct root", () => {
  it("records a created root as the operator's direct chat with owner-private memory", async () => {
    const { sessionKey, entry, senderIsOwner } = await runLocalRoot(true);

    expect(entry.chatType).toBe("direct");
    expect(senderIsOwner).toBe(true);
    const resolution = await resolveMemoryAudienceFromEntry(
      {
        agentId: "main",
        sessionKey,
        sessionId: entry.sessionId,
        senderIsOwner,
        storePath: requireStorePath(),
      },
      entry,
    );
    expect(resolution).toMatchObject({
      status: "granted",
      audience: { kind: "owner-private", agentId: "main" },
    });
    if (resolution.status === "granted") {
      resolution.release();
    }
  });

  it("leaves other local roots without a chat type", async () => {
    const { entry } = await runLocalRoot();

    expect(entry.chatType).toBeUndefined();
  });
});

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
    return makeResult({
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
