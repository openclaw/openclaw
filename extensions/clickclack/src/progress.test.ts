import { describe, expect, it, vi } from "vitest";
import {
  createClickClackAgentProgressPublisher,
  type ClickClackItemEventPayload,
} from "./progress.js";

type PublisherOptions = Parameters<typeof createClickClackAgentProgressPublisher>[0];

const retractionCases: {
  name: string;
  initial: ClickClackItemEventPayload;
  end: ClickClackItemEventPayload;
}[] = [
  {
    name: "commentary",
    initial: { itemId: "preamble_1", kind: "preamble", progressText: "Temporary note" },
    end: { itemId: "preamble_1", kind: "preamble", progressText: "" },
  },
  {
    name: "model wait",
    initial: {
      itemId: "model-wait",
      kind: "model-wait",
      phase: "update",
      progressText: "Waiting for the local model to respond",
      suppressDurableProgress: true,
    },
    end: {
      itemId: "model-wait",
      kind: "model-wait",
      phase: "end",
      suppressDurableProgress: true,
    },
  },
];

function createPublisher(
  publishEphemeral: PublisherOptions["client"]["publishEphemeral"],
  options: Partial<Omit<PublisherOptions, "client">> = {},
) {
  return createClickClackAgentProgressPublisher({
    client: { publishEphemeral },
    target: { workspaceId: "ws_1", channelId: "chn_1" },
    turnId: "msg_1",
    ...options,
  });
}

describe("ClickClack native agent progress", () => {
  it("serializes turn, item, completion, and clear frames", async () => {
    const publishEphemeral = vi.fn().mockResolvedValue(undefined);
    const publisher = createPublisher(publishEphemeral, { agentLabel: "Blackbird" });

    publisher.start();
    publisher.onItemEvent({
      itemId: "tool_1",
      kind: "tool",
      name: "search",
      progressText: "Searching",
      status: "running",
    });
    publisher.onItemEvent({
      itemId: "tool_1",
      toolCallId: "call_1",
      kind: "tool",
      name: "search",
      progressText: "Done",
      phase: "end",
      status: "completed",
    });
    await publisher.finalize();

    expect(publishEphemeral).toHaveBeenCalledTimes(3);
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
    expect(publishEphemeral.mock.calls[1]?.[0].payload).toMatchObject({
      op: "finalize",
      line: {
        id: "item:tool_1",
        kind: "tool",
        tool_name: "search",
        text: "Search: Done",
        status: "completed",
      },
    });
    expect(publishEphemeral.mock.calls[2]?.[0].payload).toMatchObject({
      turn_id: "msg_1",
      op: "clear",
    });
  });

  it("hides command metadata from item-only native progress", async () => {
    const publishEphemeral = vi.fn().mockResolvedValue(undefined);
    const publisher = createPublisher(publishEphemeral);

    publisher.start();
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
    expect(publishEphemeral.mock.calls[1]?.[0].payload).toMatchObject({
      line: { text: "Server.exec" },
    });
  });

  it("does not let a progress transport failure interrupt finalization", async () => {
    const onError = vi.fn();
    const publishEphemeral = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const publisher = createPublisher(publishEphemeral, {
      target: { workspaceId: "ws_1", conversationId: "dm_1" },
      onError,
    });

    publisher.start();
    await expect(publisher.finalize()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(publishEphemeral).toHaveBeenCalledTimes(2);
  });

  it("coalesces queued line updates while the transport is in flight", async () => {
    let releaseFirstRequest!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    const publishEphemeral = vi
      .fn()
      .mockImplementationOnce(() => firstRequest)
      .mockResolvedValue(undefined);
    const publisher = createPublisher(publishEphemeral);

    publisher.start();
    publisher.onItemEvent({ itemId: "tool_1", kind: "tool", progressText: "first" });
    publisher.onItemEvent({ itemId: "tool_1", kind: "tool", progressText: "second" });
    publisher.onItemEvent({ itemId: "tool_1", kind: "tool", progressText: "latest" });
    const finalized = publisher.finalize();

    expect(publishEphemeral).toHaveBeenCalledTimes(1);
    releaseFirstRequest();
    await finalized;

    expect(publishEphemeral).toHaveBeenCalledTimes(3);
    expect(publishEphemeral.mock.calls[1]?.[0].payload).toMatchObject({
      op: "append",
      line: { id: "item:tool_1", text: expect.stringContaining("latest") },
    });
    expect(publishEphemeral.mock.calls[2]?.[0].payload).toMatchObject({ op: "clear" });
  });

  it("retains a newer completion when an older line drains before its next flush", async () => {
    vi.useFakeTimers();
    let releaseFirstRequest!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    const publishEphemeral = vi
      .fn()
      .mockImplementationOnce(() => firstRequest)
      .mockResolvedValue(undefined);
    const publisher = createPublisher(publishEphemeral);
    try {
      publisher.start();
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
    "retracts an existing $name line without replacing it with a placeholder",
    async ({ initial, end }) => {
      vi.useFakeTimers();
      try {
        const publishEphemeral = vi.fn().mockResolvedValue(undefined);
        const publisher = createPublisher(publishEphemeral);

        publisher.start();
        await vi.advanceTimersByTimeAsync(0);
        publisher.onItemEvent(initial);
        await vi.advanceTimersByTimeAsync(100);
        publisher.onItemEvent(end);
        await vi.advanceTimersByTimeAsync(100);
        await publisher.finalize();

        expect(publishEphemeral.mock.calls[1]?.[0].payload).toMatchObject({
          op: "append",
          line: { id: `item:${initial.itemId}`, text: initial.progressText },
        });
        expect(publishEphemeral.mock.calls[2]?.[0].payload).toMatchObject({
          op: "update",
          line: { id: `item:${initial.itemId}`, text: "" },
        });
        expect(publishEphemeral.mock.calls[3]?.[0].payload).toMatchObject({ op: "clear" });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(retractionCases)(
    "drops $name retracted before its first progress frame is published",
    async ({ initial, end }) => {
      vi.useFakeTimers();
      try {
        const publishEphemeral = vi.fn().mockResolvedValue(undefined);
        const publisher = createPublisher(publishEphemeral);

        publisher.start();
        await vi.advanceTimersByTimeAsync(0);
        publisher.onItemEvent(initial);
        publisher.onItemEvent(end);
        await publisher.finalize();

        expect(publishEphemeral).toHaveBeenCalledTimes(2);
        expect(publishEphemeral.mock.calls[0]?.[0].payload).toMatchObject({
          op: "append",
          line: { id: "turn" },
        });
        expect(publishEphemeral.mock.calls[1]?.[0].payload).toMatchObject({ op: "clear" });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("does not let a stalled transport hold turn finalization", async () => {
    vi.useFakeTimers();
    let releaseFirstRequest!: () => void;
    try {
      const firstRequest = new Promise<void>((resolve) => {
        releaseFirstRequest = resolve;
      });
      const publishEphemeral = vi
        .fn()
        .mockImplementationOnce(() => firstRequest)
        .mockResolvedValue(undefined);
      const publisher = createPublisher(publishEphemeral);

      publisher.start();
      publisher.onItemEvent({ itemId: "tool_1", kind: "tool", progressText: "pending" });
      const finalized = publisher.finalize();
      const onFinalized = vi.fn();
      void finalized.then(onFinalized);

      await vi.advanceTimersByTimeAsync(999);
      expect(onFinalized).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await finalized;

      expect(onFinalized).toHaveBeenCalledOnce();
      expect(publishEphemeral).toHaveBeenCalledTimes(1);

      releaseFirstRequest();
      await vi.advanceTimersByTimeAsync(0);
      expect(publishEphemeral).toHaveBeenCalledTimes(2);
      expect(publishEphemeral.mock.calls[1]?.[0].payload).toMatchObject({ op: "clear" });
    } finally {
      releaseFirstRequest();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });
});
