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

function eventsFor(calls: Parameters<OnEvent>[], stream: string, toolCallId: string) {
  return calls
    .map(([event]) => event)
    .filter((event) => event.stream === stream && event.data?.toolCallId === toolCallId);
}

setupRunAttemptTestHooks();
beforeEach(() => vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }));

it("keeps raw command detail behind the channel commandText policy", async () => {
  const harness = createStartedThreadHarness();
  const params = createTestParams();
  const onAgentEvent = vi.fn<OnEvent>();
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
  const toolStart = eventsFor(onAgentEvent.mock.calls, "tool", "private-command-1").find(
    ({ data }) => data?.phase === "start",
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

  const cases: Array<[name: string, item?: JsonObject, completion?: JsonObject]> = [
    [
      "bash",
      {
        type: "commandExecution",
        command: "printf private-command",
        cwd: params.workspaceDir,
      },
      { aggregatedOutput: "done", exitCode: 0, durationMs: 1 },
    ],
    ["apply_patch", { type: "fileChange", changes: [{ path: "proof.txt", kind: "update" }] }],
    [
      "web_search",
      {
        type: "webSearch",
        query: "OpenClaw repository",
        action: { type: "search", query: "OpenClaw repository" },
      },
      { durationMs: 1 },
    ],
    [
      "progressproof.parity_probe",
      {
        type: "mcpToolCall",
        server: "progressproof",
        tool: "parity_probe",
        arguments: { marker: "telegram-progress" },
      },
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
    const toolEvents = eventsFor(onAgentEvent.mock.calls, "tool", toolCallId).filter(
      ({ data }) => data?.name === name,
    );

    expect(
      toolEvents.map(({ data }) => data?.phase),
      name,
    ).toEqual(["start", "result"]);
    for (const event of toolEvents) {
      expect(event.data, name).not.toHaveProperty("hideFromChannelProgress");
    }
    expect(onToolResult.mock.calls.length, `${name} verbose callback`).toBe(resultCount + 1);
    const prepared = eventsFor(onAgentEvent.mock.calls, "item", toolCallId).filter(
      ({ data }) => !data.suppressChannelProgress,
    );
    expect(
      prepared.map(({ data }) => [data.phase, data.itemId]),
      name,
    ).toEqual([
      ["start", `tool:${toolCallId}`],
      ["end", `tool:${toolCallId}`],
    ]);
    expect(onToolResult.mock.calls[resultCount]?.[0], name).toMatchObject({
      channelData: { openclawToolProgressId: prepared[0]?.data.itemId },
    });
  }

  await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  await run;
});
