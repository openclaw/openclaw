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
    Object.assign(params, {
      config: {
        channels: {
          telegram: {
            streaming: { mode: "progress", progress: { commandText: "status" } },
          },
        },
      },
      messageChannel: "telegram",
      toolProgressDetail: "raw",
      verboseLevel: "full",
      onAgentEvent,
      onToolResult,
    });
    const command = "printf raw-command-must-stay-private";
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/started", {
        type: "commandExecution",
        id: "private-command-1",
        command,
        cwd: params.workspaceDir,
        status: "inProgress",
      }),
    );
    await progressReceived.promise;
    expect(onToolResult).toHaveBeenCalledWith({
      text: "Bash",
      channelData: { openclawToolProgressId: "tool:private-command-1" },
    });
    const start = onAgentEvent.mock.calls
      .map(([event]) => event)
      .find((event) => event.stream === "tool" && event.data?.phase === "start");
    expect(start?.data?.args).toEqual({ command, cwd: params.workspaceDir });
    expect(start?.data?.meta).toContain("raw-command-must-stay-private");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  });

  it.each<[string, JsonObject?, JsonObject?]>([
    [
      "bash",
      { type: "commandExecution", command: "printf private-command" },
      { aggregatedOutput: "done", exitCode: 0, durationMs: 1 },
    ],
    ["apply_patch", { type: "fileChange", changes: [{ path: "proof.txt", kind: "update" }] }],
    [
      "web_search",
      { type: "webSearch", query: "OpenClaw", action: { type: "search", query: "OpenClaw" } },
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
  ])(
    "keeps %s available to channel policy and verbose callbacks",
    async (name, item, completion) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const harness = createStartedThreadHarness();
      const params = createTestParams();
      const ended = createDeferred<void>();
      const progress = createDeferred<void>();
      const onAgentEvent = vi.fn<NonNullable<typeof params.onAgentEvent>>((event) => {
        if (
          event.stream === "item" &&
          event.data.phase === "end" &&
          event.data.toolCallId === "tool-1"
        ) {
          ended.resolve();
        }
      });
      const onToolResult = vi.fn<NonNullable<typeof params.onToolResult>>((payload) => {
        if (payload.channelData?.openclawToolProgressId === "tool:tool-1") {
          progress.resolve();
        }
      });
      Object.assign(params, {
        messageChannel: "telegram",
        verboseLevel: "on",
        onAgentEvent,
        onToolResult,
      });
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      if (item) {
        const nativeItem = {
          ...item,
          id: "tool-1",
          ...(name === "bash" ? { cwd: params.workspaceDir } : {}),
        };
        await harness.notify(
          itemNotification("item/started", { ...nativeItem, status: "inProgress" }),
        );
        await harness.notify(
          itemNotification("item/completed", {
            ...nativeItem,
            status: "completed",
            ...completion,
          }),
        );
      } else {
        await harness.handleServerRequest({
          id: "request-dynamic-1",
          method: "item/tool/call",
          params: createDynamicToolCall(name, {}, "tool-1"),
        });
      }
      await Promise.all([ended.promise, progress.promise]);
      const events = onAgentEvent.mock.calls.map(([event]) => event);
      const toolEvents = events.filter(
        (event) => event.stream === "tool" && event.data?.toolCallId === "tool-1",
      );
      expect(toolEvents.map(({ data }) => [data.name, data.phase])).toEqual([
        [name, "start"],
        [name, "result"],
      ]);
      for (const event of toolEvents) {
        expect(event.data).not.toHaveProperty("hideFromChannelProgress");
      }
      const prepared = events.filter(
        (event) =>
          event.stream === "item" &&
          event.data.toolCallId === "tool-1" &&
          !event.data.suppressChannelProgress,
      );
      expect(prepared.map(({ data }) => [data.phase, data.itemId])).toEqual([
        ["start", "tool:tool-1"],
        ["end", "tool:tool-1"],
      ]);
      expect(onToolResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          channelData: { openclawToolProgressId: "tool:tool-1" },
        }),
      );
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
    },
  );
});
