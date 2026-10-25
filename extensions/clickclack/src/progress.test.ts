import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createClickClackAgentProgressPublisher,
  type ClickClackItemEventPayload,
} from "./progress.js";

type PublisherOptions = Parameters<typeof createClickClackAgentProgressPublisher>[0];
type Publish = PublisherOptions["client"]["publishEphemeral"];

const retractionCases = ["commentary", "model wait"].flatMap((name) => {
  const initial: ClickClackItemEventPayload =
    name === "commentary"
      ? { itemId: "preamble_1", kind: "preamble", progressText: "Temporary note" }
      : {
          itemId: "model-wait",
          kind: "model-wait",
          phase: "update",
          progressText: "Waiting for the local model to respond",
          suppressDurableProgress: true,
        };
  const end =
    name === "commentary" ? { progressText: "" } : { phase: "end", progressText: undefined };
  const events = { name, initial, end: { ...initial, ...end } };
  return [false, true].map((published) => Object.assign({ published }, events));
});

function createPublisher(
  options: Partial<Omit<PublisherOptions, "client">> = {},
  publishEphemeral = vi.fn<Publish>().mockResolvedValue(undefined),
) {
  const publisher = createClickClackAgentProgressPublisher({
    client: { publishEphemeral },
    target: { workspaceId: "ws_1", channelId: "chn_1" },
    turnId: "msg_1",
    ...options,
  });
  publisher.start();
  const frame = (index: number) => publishEphemeral.mock.calls[index]?.[0].payload;
  return { publisher, publishEphemeral, frame };
}

function blockedTransport() {
  const request = Promise.withResolvers<void>();
  const publishEphemeral = vi.fn<Publish>().mockResolvedValue(undefined);
  publishEphemeral.mockImplementationOnce(() => request.promise);
  return { request, ...createPublisher({}, publishEphemeral) };
}

describe("ClickClack native agent progress", () => {
  afterEach(() => vi.useRealTimers());

  it("serializes turn, item, completion, and clear frames", async () => {
    const { publisher, publishEphemeral, frame } = createPublisher({ agentLabel: "Blackbird" });
    const tool = { itemId: "tool_1", kind: "tool", name: "search" };
    publisher.onItemEvent({ ...tool, progressText: "Searching", status: "running" });
    publisher.onItemEvent({
      ...tool,
      toolCallId: "call_1",
      progressText: "Done",
      phase: "end",
      status: "completed",
    });
    await publisher.finalize();

    expect(publishEphemeral.mock.calls.map(([call]) => call.payload?.seq)).toEqual([1, 2, 3]);
    expect(publishEphemeral.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws_1",
      channelId: "chn_1",
      type: "agent.progress",
      payload: {
        turn_id: "msg_1",
        op: "append",
        line: { id: "turn", text: "Blackbird is responding", status: "running" },
      },
    });
    expect(frame(1)).toMatchObject({
      op: "finalize",
      line: {
        id: "item:tool_1",
        kind: "tool",
        tool_name: "search",
        text: "Search: Done",
        status: "completed",
      },
    });
    expect(frame(2)).toMatchObject({ turn_id: "msg_1", op: "clear" });
  });

  it("hides command metadata from item-only native progress", async () => {
    const { publisher, publishEphemeral, frame } = createPublisher();
    publisher.onItemEvent({
      itemId: "tool_1",
      kind: "tool",
      name: "server.exec",
      meta: "echo private-sentinel",
      commandBearing: true,
      phase: "end",
      status: "completed",
    });
    await publisher.finalize();

    expect(JSON.stringify(publishEphemeral.mock.calls)).not.toContain("private-sentinel");
    expect(frame(1)).toMatchObject({ line: { text: "Server.exec" } });
  });

  it("does not let a progress transport failure interrupt finalization", async () => {
    const onError = vi.fn();
    const publishEphemeral = vi.fn<Publish>().mockResolvedValue(undefined);
    publishEphemeral.mockRejectedValueOnce(new Error("offline"));
    const { publisher } = createPublisher(
      { target: { workspaceId: "ws_1", conversationId: "dm_1" }, onError },
      publishEphemeral,
    );
    await expect(publisher.finalize()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(publishEphemeral).toHaveBeenCalledTimes(2);
  });

  it("coalesces queued line updates while the transport is in flight", async () => {
    const { request, publishEphemeral, publisher, frame } = blockedTransport();
    publisher.onItemEvent({ itemId: "tool_1", kind: "tool", progressText: "first" });
    publisher.onItemEvent({ itemId: "tool_1", kind: "tool", progressText: "latest" });
    const finalized = publisher.finalize();

    expect(publishEphemeral).toHaveBeenCalledTimes(1);
    request.resolve();
    await finalized;

    expect(publishEphemeral).toHaveBeenCalledTimes(3);
    expect(frame(1)).toMatchObject({
      op: "append",
      line: { id: "item:tool_1", text: expect.stringContaining("latest") },
    });
    expect(frame(2)).toMatchObject({ op: "clear" });
  });

  it("retains a newer completion when an older line drains before its next flush", async () => {
    vi.useFakeTimers();
    const { promise: firstRequest, resolve: releaseFirstRequest } = Promise.withResolvers<void>();
    const publishEphemeral = vi
      .fn()
      .mockImplementationOnce(() => firstRequest)
      .mockResolvedValue(undefined);
    const { publisher } = createPublisher({}, publishEphemeral);
    try {
      publisher.onItemEvent({ itemId: "tool_1", kind: "tool", title: "Searching" });
      await vi.advanceTimersByTimeAsync(100);
      publisher.onItemEvent({
        itemId: "tool_1",
        kind: "tool",
        title: "Done",
        phase: "end",
        status: "completed",
      });
      releaseFirstRequest();
      await vi.advanceTimersByTimeAsync(100);

      expect(publishEphemeral.mock.calls.map(([call]) => call.payload)).toMatchObject([
        { seq: 1, op: "append", line: { id: "turn" } },
        { seq: 2, op: "append", line: { id: "item:tool_1", text: "Searching" } },
        { seq: 3, op: "finalize", line: { id: "item:tool_1", text: "Done", status: "completed" } },
      ]);
    } finally {
      releaseFirstRequest();
      await publisher.finalize();
      vi.useRealTimers();
    }
  });

  it.each(retractionCases)(
    "retracts $name without a placeholder (already published: $published)",
    async ({ initial, end, published }) => {
      vi.useFakeTimers();
      const { publisher, publishEphemeral, frame } = createPublisher();
      await vi.advanceTimersByTimeAsync(0);
      publisher.onItemEvent(initial);
      if (published) {
        await vi.advanceTimersByTimeAsync(100);
      }
      publisher.onItemEvent(end);
      if (published) {
        await vi.advanceTimersByTimeAsync(100);
      }
      await publisher.finalize();

      if (published) {
        expect(frame(1)).toMatchObject({
          op: "append",
          line: { id: `item:${initial.itemId}`, text: initial.progressText },
        });
        expect(frame(2)).toMatchObject({
          op: "update",
          line: { id: `item:${initial.itemId}`, text: "" },
        });
        expect(frame(3)).toMatchObject({ op: "clear" });
      } else {
        expect(publishEphemeral).toHaveBeenCalledTimes(2);
        expect(frame(0)).toMatchObject({ op: "append", line: { id: "turn" } });
        expect(frame(1)).toMatchObject({ op: "clear" });
      }
    },
  );

  it("does not let a stalled transport hold turn finalization", async () => {
    vi.useFakeTimers();
    const { request, publishEphemeral, publisher, frame } = blockedTransport();
    try {
      publisher.onItemEvent({ itemId: "tool_1", kind: "tool", progressText: "pending" });
      const finalized = publisher.finalize();
      const onFinalized = vi.fn();
      void finalized.then(onFinalized);

      await vi.advanceTimersByTimeAsync(999);
      expect(onFinalized).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await finalized;

      expect(publishEphemeral).toHaveBeenCalledTimes(1);

      request.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(publishEphemeral).toHaveBeenCalledTimes(2);
      expect(frame(1)).toMatchObject({ op: "clear" });
    } finally {
      request.resolve();
      await vi.runAllTimersAsync();
    }
  });
});
