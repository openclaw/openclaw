import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, expect, it, vi } from "vitest";
import type { JsonObject } from "./protocol.js";
import { itemNotification } from "./protocol.test-helpers.js";
import {
  createTestParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

type OnEvent = NonNullable<ReturnType<typeof createTestParams>["onAgentEvent"]>;

function eventDataFor(calls: Parameters<OnEvent>[], stream: string, toolCallId: string) {
  return calls
    .filter(([event]) => event.stream === stream && event.data?.toolCallId === toolCallId)
    .map(([{ data }]) => data);
}

setupRunAttemptTestHooks();
beforeEach(() => vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }));

it("keeps raw command detail behind the channel commandText policy", async () => {
  const harness = createStartedThreadHarness();
  const params = createTestParams();
  const onAgentEvent = vi.fn<OnEvent>();
  const progressReceived = createDeferred<void>();
  const onToolResult = vi.fn(() => progressReceived.resolve());
  const streaming = { mode: "progress", progress: { commandText: "status" } } as const;
  params.config = { channels: { telegram: { streaming } } };
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
  const toolStart = eventDataFor(onAgentEvent.mock.calls, "tool", "private-command-1").find(
    ({ phase }) => phase === "start",
  );
  expect(toolStart?.args).toEqual({
    command: "printf raw-command-must-stay-private",
    cwd: params.workspaceDir,
  });
  expect(toolStart?.meta).toContain("raw-command-must-stay-private");

  await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  await run;
});

it("keeps every tool source available to channel policy and verbose callbacks", async () => {
  const harness = createStartedThreadHarness();
  const params = createTestParams();
  let expectedToolCallId: string;
  let toolEnded = createDeferred<void>();
  let progressReceived = createDeferred<void>();
  const onAgentEvent = vi.fn<OnEvent>(({ stream, data }) => {
    if (stream === "item" && data.phase === "end" && data.toolCallId === expectedToolCallId) {
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

  const cases: Array<[name: string, item?: JsonObject, completion?: JsonObject]> = [
    [
      "bash",
      { type: "commandExecution", command: "pwd" },
      { aggregatedOutput: "done", exitCode: 0, durationMs: 1 },
    ],
    ["apply_patch", { type: "fileChange", changes: [{ path: "proof.txt", kind: "update" }] }],
    [
      "web_search",
      { type: "webSearch", query: "query", action: { type: "search" } },
      { durationMs: 1 },
    ],
    [
      "mcp.probe",
      { type: "mcpToolCall", server: "mcp", tool: "probe", arguments: {} },
      { result: { content: [{ type: "text", text: "ok" }] }, durationMs: 1 },
    ],
    ["agents_list"],
  ];

  for (const [name, sourceItem, completion] of cases) {
    const toolCallId = name;
    expectedToolCallId = toolCallId;
    toolEnded = createDeferred<void>();
    progressReceived = createDeferred<void>();
    const resultCount = onToolResult.mock.calls.length;
    if (sourceItem) {
      const item = { ...sourceItem, id: toolCallId };
      await harness.notify(itemNotification("item/started", { ...item, status: "inProgress" }));
      await harness.notify(
        itemNotification("item/completed", {
          ...item,
          status: "completed",
          ...completion,
        }),
      );
    } else {
      await harness.handleServerRequest({
        id: "request-dynamic-1",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: toolCallId,
          namespace: null,
          tool: name,
          arguments: {},
        },
      });
    }
    await Promise.all([toolEnded.promise, progressReceived.promise]);
    const toolEvents = eventDataFor(onAgentEvent.mock.calls, "tool", toolCallId).filter(
      (data) => data.name === name,
    );

    expect(toolEvents, name).toMatchObject([{ phase: "start" }, { phase: "result" }]);
    for (const data of toolEvents) {
      expect(data, name).not.toHaveProperty("hideFromChannelProgress");
    }
    expect(onToolResult.mock.calls.length, `${name} verbose callback`).toBe(resultCount + 1);
    const prepared = eventDataFor(onAgentEvent.mock.calls, "item", toolCallId).filter(
      (data) => !data.suppressChannelProgress,
    );
    const itemId = `tool:${toolCallId}`;
    expect(prepared, name).toMatchObject([
      { phase: "start", itemId },
      { phase: "end", itemId },
    ]);
    expect(onToolResult.mock.calls[resultCount]?.[0], name).toMatchObject({
      channelData: { openclawToolProgressId: prepared[0]?.itemId },
    });
  }

  await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  await run;
});
