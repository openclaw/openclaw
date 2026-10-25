import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createDynamicToolCall } from "./dynamic-tools.test-support.js";
import type { JsonObject } from "./protocol.js";
import { itemNotification } from "./protocol.test-helpers.js";
import {
  createTestParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("Codex channel tool progress", () => {
  it("keeps raw command detail behind the channel commandText policy", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    const onAgentEvent = vi.fn();
    const progressReceived = createDeferred<void>();
    const onToolResult = vi.fn(() => progressReceived.resolve());
    params.config = {
      channels: {
        telegram: {
          streaming: { mode: "progress", progress: { commandText: "status" } },
        },
      },
    };
    params.messageChannel = "telegram";
    params.toolProgressDetail = "raw";
    params.verboseLevel = "full";
    params.onAgentEvent = onAgentEvent;
    params.onToolResult = onToolResult;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/started", {
        type: "commandExecution",
        id: "private-command-1",
        command: "printf raw-command-must-stay-private",
        cwd: params.workspaceDir,
        status: "inProgress",
      }),
    );
    await progressReceived.promise;

    expect(onToolResult).toHaveBeenCalledWith({
      text: "Bash",
      channelData: { openclawToolProgressId: "tool:private-command-1" },
    });
    const toolStart = onAgentEvent.mock.calls
      .map(([event]) => event)
      .find(
        (event) =>
          event.stream === "tool" &&
          event.data?.phase === "start" &&
          event.data?.toolCallId === "private-command-1",
      );
    expect(toolStart?.data?.args).toEqual({
      command: "printf raw-command-must-stay-private",
      cwd: params.workspaceDir,
    });
    expect(toolStart?.data?.meta).toContain("raw-command-must-stay-private");

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  });

  it("keeps every tool source available to channel policy and verbose callbacks", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    let expectedToolCallId: string;
    let toolEnded = createDeferred<void>();
    let progressReceived = createDeferred<void>();
    const onAgentEvent = vi.fn<NonNullable<typeof params.onAgentEvent>>((event) => {
      if (
        event.stream === "item" &&
        event.data.phase === "end" &&
        event.data.toolCallId === expectedToolCallId
      ) {
        toolEnded.resolve();
      }
    });
    const onToolResult = vi.fn<NonNullable<typeof params.onToolResult>>((payload) => {
      if (payload.channelData?.openclawToolProgressId === `tool:${expectedToolCallId}`) {
        progressReceived.resolve();
      }
    });
    params.messageChannel = "telegram";
    params.verboseLevel = "on";
    params.onAgentEvent = onAgentEvent;
    params.onToolResult = onToolResult;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const cases: Array<{
      toolCallId: string;
      name: string;
      item?: JsonObject;
      completion?: JsonObject;
    }> = [
      {
        toolCallId: "command-1",
        name: "bash",
        item: {
          type: "commandExecution",
          command: "printf private-command",
          cwd: params.workspaceDir,
        },
        completion: { aggregatedOutput: "done", exitCode: 0, durationMs: 1 },
      },
      {
        toolCallId: "patch-1",
        name: "apply_patch",
        item: { type: "fileChange", changes: [{ path: "proof.txt", kind: "update" }] },
      },
      {
        toolCallId: "search-1",
        name: "web_search",
        item: {
          type: "webSearch",
          query: "OpenClaw repository",
          action: { type: "search", query: "OpenClaw repository" },
        },
        completion: { durationMs: 1 },
      },
      {
        toolCallId: "mcp-1",
        name: "progressproof.parity_probe",
        item: {
          type: "mcpToolCall",
          server: "progressproof",
          tool: "parity_probe",
          arguments: { marker: "telegram-progress" },
        },
        completion: { result: { content: [{ type: "text", text: "ok" }] }, durationMs: 1 },
      },
      { toolCallId: "dynamic-1", name: "agents_list" },
    ];

    for (const testCase of cases) {
      expectedToolCallId = testCase.toolCallId;
      toolEnded = createDeferred<void>();
      progressReceived = createDeferred<void>();
      const resultCount = onToolResult.mock.calls.length;
      if (testCase.item) {
        const item = { ...testCase.item, id: testCase.toolCallId };
        await harness.notify(itemNotification("item/started", { ...item, status: "inProgress" }));
        await harness.notify(
          itemNotification("item/completed", {
            ...item,
            status: "completed",
            ...testCase.completion,
          }),
        );
      } else {
        await harness.handleServerRequest({
          id: "request-dynamic-1",
          method: "item/tool/call",
          params: createDynamicToolCall(testCase.name, {}, testCase.toolCallId),
        });
      }
      await Promise.all([toolEnded.promise, progressReceived.promise]);
      const toolEvents = onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter(
          (event) =>
            event.stream === "tool" &&
            event.data?.toolCallId === testCase.toolCallId &&
            event.data?.name === testCase.name,
        );

      expect(
        toolEvents.map((event) => event.data?.phase),
        `${testCase.name} lifecycle`,
      ).toEqual(["start", "result"]);
      for (const event of toolEvents) {
        expect(event.data, testCase.name).not.toHaveProperty("hideFromChannelProgress");
      }
      expect(onToolResult.mock.calls.length, `${testCase.name} verbose callback`).toBe(
        resultCount + 1,
      );
      const prepared = onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter(
          (event) =>
            event.stream === "item" &&
            event.data.toolCallId === testCase.toolCallId &&
            !event.data.suppressChannelProgress,
        );
      const itemId = `tool:${testCase.toolCallId}`;
      expect(
        prepared.map(({ data }) => [data.phase, data.itemId]),
        testCase.name,
      ).toEqual([
        ["start", itemId],
        ["end", itemId],
      ]);
      expect(onToolResult.mock.calls[resultCount]?.[0], testCase.name).toMatchObject({
        channelData: { openclawToolProgressId: prepared[0]?.data.itemId },
      });
    }

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  });
});
