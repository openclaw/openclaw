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
  const frames = () => publishEphemeral.mock.calls.map(([call]) => call.payload);
  return { publisher, publishEphemeral, frames };
}

function blockedTransport() {
  const request = Promise.withResolvers<void>();
  const publishEphemeral = vi.fn<Publish>().mockResolvedValue(undefined);
  publishEphemeral.mockImplementationOnce(() => request.promise);
  return { request, ...createPublisher({}, publishEphemeral) };
}

describe("ClickClack native agent progress", () => {
  afterEach(() => vi.useRealTimers());

  it("serializes turn, private-command completion, and clear frames", async () => {
    const { publisher, publishEphemeral, frames } = createPublisher({ agentLabel: "Blackbird" });
    const tool = {
      itemId: "tool_1",
      kind: "tool",
      name: "server.exec",
      meta: "echo private-sentinel",
      commandBearing: true,
    };
    publisher.onItemEvent({ ...tool, progressText: "Searching", status: "running" });
    publisher.onItemEvent({
      ...tool,
      toolCallId: "call_1",
      progressText: "Done",
      phase: "end",
      status: "completed",
    });
    await publisher.finalize();

    expect(JSON.stringify(publishEphemeral.mock.calls)).not.toContain("private-sentinel");
    expect(publishEphemeral.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws_1",
      channelId: "chn_1",
      type: "agent.progress",
    });
    expect(frames()).toMatchObject([
      {
        seq: 1,
        turn_id: "msg_1",
        op: "append",
        line: { id: "turn", text: "Blackbird is responding", status: "running" },
      },
      {
        seq: 2,
        op: "finalize",
        line: {
          id: "item:tool_1",
          kind: "tool",
          tool_name: "server.exec",
          text: "Server.exec",
          status: "completed",
        },
      },
      { seq: 3, turn_id: "msg_1", op: "clear" },
    ]);
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
    const { request, publishEphemeral, publisher, frames } = blockedTransport();
    publisher.onItemEvent({ itemId: "tool_1", kind: "tool", progressText: "first" });
    publisher.onItemEvent({ itemId: "tool_1", kind: "tool", progressText: "latest" });
    const finalized = publisher.finalize();

    expect(publishEphemeral).toHaveBeenCalledTimes(1);
    request.resolve();
    await finalized;

    expect(frames()).toMatchObject([
      {},
      { op: "append", line: { id: "item:tool_1", text: expect.stringContaining("latest") } },
      { op: "clear" },
    ]);
  });

  it("retains a newer completion when an older line drains before its next flush", async () => {
    vi.useFakeTimers();
    const { request, publisher, frames } = blockedTransport();
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
      request.resolve();
      await vi.advanceTimersByTimeAsync(100);

      expect(frames()).toMatchObject([
        { seq: 1, op: "append", line: { id: "turn" } },
        { seq: 2, op: "append", line: { id: "item:tool_1", text: "Searching" } },
        { seq: 3, op: "finalize", line: { id: "item:tool_1", text: "Done", status: "completed" } },
      ]);
    } finally {
      request.resolve();
      await publisher.finalize();
    }
  });

  it.each(retractionCases)(
    "retracts $name without a placeholder (already published: $published)",
    async ({ initial, end, published }) => {
      vi.useFakeTimers();
      const { publisher, frames } = createPublisher();
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
        expect(frames().slice(1)).toMatchObject([
          { op: "append", line: { id: `item:${initial.itemId}`, text: initial.progressText } },
          { op: "update", line: { id: `item:${initial.itemId}`, text: "" } },
          { op: "clear" },
        ]);
      } else {
        expect(frames()).toMatchObject([{ op: "append", line: { id: "turn" } }, { op: "clear" }]);
      }
    },
  );

  it("does not let a stalled transport hold turn finalization", async () => {
    vi.useFakeTimers();
    const { request, publishEphemeral, publisher, frames } = blockedTransport();
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
      expect(frames()[1]).toMatchObject({ op: "clear" });
    } finally {
      request.resolve();
      await vi.runAllTimersAsync();
    }
  });
});
