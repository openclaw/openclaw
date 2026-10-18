import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { installMessageToolTerminalHook } from "./embedded-agent-runner/run/message-tool-terminal.js";
import {
  terminalModel,
  terminalResponse,
  terminalToolCall,
} from "./embedded-agent-runner/run/message-tool-terminal.test-support.js";
import { Agent, type AgentTool } from "./runtime/index.js";
import { jsonResult } from "./tools/common.js";
import { createMessageTool } from "./tools/message-tool-execution.js";

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

describe("message-tool-only steering", () => {
  it("delivers the earlier visible reply before applying the steer", async () => {
    const started = createDeferred();
    const release = createDeferred();
    const sent: string[] = [];
    let deliveries = 0;
    let requests = 0;
    const config = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(config);
    const message = createMessageTool({
      config,
      preparedMessageToolCatalog: { version: 0, channels: [], getChannel: () => undefined },
      currentChannelProvider: "webchat",
      sourceReplyDeliveryMode: "message_tool_only",
      agentSessionKey: "agent:main:webchat:dm:steering-176028",
      runSessionKey: "agent:main:webchat:dm:steering-176028",
      runId: "steering-176028",
      getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
      resolveCommandSecretRefsViaGateway: async ({ config: resolvedConfig }) => ({
        resolvedConfig,
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
      }),
      runMessageAction: async (input) => {
        sent.push(String(input.params.message));
        return {
          kind: "send",
          channel: "webchat",
          action: "send",
          to: "current-run",
          handledBy: "internal-source",
          payload: {},
          toolResult: jsonResult({ ok: true }),
          dryRun: false,
        };
      },
    });
    expect(
      message.shouldExecuteBeforeSteering?.({ action: "send", message: "reply", final: true }),
    ).toBe(true);
    const lookup: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "Run a sequential lookup",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => {
        started.resolve();
        await release.promise;
        return jsonResult({ value: 42 });
      },
    };
    const agent = new Agent({
      initialState: { model: terminalModel, tools: [lookup, message] },
      streamFn: () => {
        requests += 1;
        if (requests > 2) {
          return terminalResponse([{ type: "text", text: "done" }], "stop");
        }
        return terminalResponse(
          requests === 1
            ? [
                terminalToolCall("lookup", "lookup-a"),
                terminalToolCall("message", "message-a", {
                  action: "send",
                  message: "Answer for input A.",
                  final: true,
                }),
              ]
            : [
                terminalToolCall("message", "message-b", {
                  action: "send",
                  message: "Answer for input B.",
                  final: true,
                }),
              ],
          "toolUse",
        );
      },
    });
    installMessageToolTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply: () => {
        deliveries += 1;
      },
    });

    const run = agent.prompt("Input A: answer through the message tool.");
    await started.promise;
    agent.steer({ role: "user", content: "Input B: answer this too.", timestamp: 2 });
    expect(agent.hasQueuedMessages()).toBe(true);
    release.resolve();
    await run;

    expect({ sent, requests, deliveries }).toEqual({
      sent: ["Answer for input A.", "Answer for input B."],
      requests: 2,
      deliveries: 2,
    });
  });
});
