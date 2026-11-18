import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClickClackActivityPublisher } from "./activity.js";
import type { ClickClackItemEventPayload } from "./progress.js";
import type { ClickClackMessage } from "./types.js";

type ActivityClient = Parameters<typeof createClickClackActivityPublisher>[0]["client"];

function createPublisher(options: Partial<Omit<PublisherOptions, "client">> = {}) {
  let counter = 0;
  const createActivityMessage = vi.fn<ActivityClient["createActivityMessage"]>(async () => {
    counter += 1;
    return { id: `msg_${counter}` } as ClickClackMessage;
  });
  const updateMessageBody = vi.fn<ActivityClient["updateMessageBody"]>(
    async () => ({}) as ClickClackMessage,
  );
  return {
    publisher: createClickClackActivityPublisher({
      client: { createActivityMessage, updateMessageBody },
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
      ...options,
    }),
    createActivityMessage,
    updateMessageBody,
  };
}

type PublisherOptions = Parameters<typeof createClickClackActivityPublisher>[0];

const tool = (overrides: Partial<ClickClackItemEventPayload> = {}): ClickClackItemEventPayload => ({
  itemId: "work",
  kind: "tool",
  name: "read",
  ...overrides,
});
const commentary = (
  progressText: string,
  overrides: Partial<ClickClackItemEventPayload> = {},
): ClickClackItemEventPayload => ({ itemId: "c1", kind: "preamble", progressText, ...overrides });

describe("createClickClackActivityPublisher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps complete commentary during a partial successor and accepts shorter completion", async () => {
    const { publisher, createActivityMessage, updateMessageBody } = createPublisher();

    publisher.onItemEvent(commentary("First and second"));
    await vi.advanceTimersByTimeAsync(700);
    publisher.onItemEvent(commentary("First and second"));
    publisher.onItemEvent(commentary("First", { phase: "update" }));
    await publisher.finalize();

    expect(createActivityMessage).toHaveBeenCalledTimes(1);
    expect(updateMessageBody).not.toHaveBeenCalled();
    publisher.onItemEvent(commentary("Done", { phase: "end" }));
    await publisher.finalize();
    expect(updateMessageBody).toHaveBeenLastCalledWith("msg_1", "Done");
    publisher.onItemEvent(commentary("", { phase: "update" }));
    await publisher.finalize();
    expect(updateMessageBody).toHaveBeenLastCalledWith("msg_1", "");
  });

  it("consumes canonical item ownership without rendering suppressed diagnostic siblings", async () => {
    const { publisher, createActivityMessage, updateMessageBody } = createPublisher();

    const event = tool({ itemId: "tool:toolu_1", toolCallId: "toolu_1", name: "exec" });
    publisher.onItemEvent({
      ...event,
      meta: "echo private-sentinel",
      commandBearing: true,
    });
    await publisher.finalize();
    publisher.onItemEvent({
      ...event,
      itemId: "command:toolu_1",
      kind: "command",
      progressText: "ls -la",
      suppressChannelProgress: true,
    });
    publisher.onItemEvent(event);
    await publisher.finalize();

    expect(createActivityMessage.mock.calls).toMatchObject([
      [{ kind: "agent_tool", body: "Exec" }],
    ]);
    expect(updateMessageBody).not.toHaveBeenCalled();
    expect(JSON.stringify(createActivityMessage.mock.calls)).not.toContain("private-sentinel");
  });

  it("posts the upgraded body directly when frames land before the first POST runs", async () => {
    const { publisher, createActivityMessage, updateMessageBody } = createPublisher();

    const event = tool({ itemId: undefined, toolCallId: "toolu_1" });
    publisher.onItemEvent(event);
    publisher.onItemEvent({ ...event, progressText: "Done" });
    await publisher.finalize();

    expect(createActivityMessage.mock.calls).toMatchObject([
      [{ kind: "agent_tool", body: "Read: Done" }],
    ]);
    expect(updateMessageBody).not.toHaveBeenCalled();
  });

  it.each(["POST", "PATCH"])(
    "publishes status-only updates arriving during an activity %s",
    async (operation) => {
      const { publisher, createActivityMessage, updateMessageBody } = createPublisher();
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let remoteBody = "";
      let blocked = false;
      const write = async (method: string, body: string): Promise<ClickClackMessage> => {
        if (method === operation && !blocked) {
          blocked = true;
          entered.resolve();
          await resume.promise;
        }
        remoteBody = body;
        return {
          id: "msg_1",
          workspace_id: "wsp_1",
          author_id: "usr_agent",
          thread_root_id: "msg_turn",
          body,
          body_format: "markdown",
          created_at: "2026-10-15T00:00:00.000Z",
        };
      };
      createActivityMessage.mockImplementation(async ({ body }) => write("POST", body));
      updateMessageBody.mockImplementation(async (_id, body) => write("PATCH", body));
      const event = tool({ title: "Read sample", progressText: "sample.txt" });

      publisher.onItemEvent({ ...event, status: "running" });
      if (operation === "PATCH") {
        await publisher.finalize();
        publisher.onItemEvent({ ...event, status: "blocked" });
      }
      await entered.promise;
      publisher.onItemEvent({ ...event, status: "failed" });
      resume.resolve();
      await publisher.finalize();

      expect(createActivityMessage).toHaveBeenCalledOnce();
      expect(remoteBody).toBe("Read sample: failed; sample.txt");
    },
  );

  it("does not retry an ambiguous failed activity POST when a later frame arrives", async () => {
    const onError = vi.fn();
    const { publisher, createActivityMessage, updateMessageBody } = createPublisher({ onError });
    createActivityMessage.mockRejectedValueOnce(new Error("connection lost after dispatch"));
    const event = tool();

    publisher.onItemEvent({ ...event, progressText: "First" });
    await expect(publisher.finalize()).resolves.toBeUndefined();
    publisher.onItemEvent({ ...event, progressText: "Latest" });
    await publisher.finalize();

    expect(onError).toHaveBeenCalledOnce();
    expect(createActivityMessage).toHaveBeenCalledOnce();
    expect(updateMessageBody).not.toHaveBeenCalled();
  });

  it("posts non-tool commentary with provenance and skips lifecycle lanes", async () => {
    const { publisher, createActivityMessage } = createPublisher();
    const provenance = { model: "anthropic/claude-opus-4-8", thinking: "low" };
    publisher.setProvenance(provenance);
    publisher.onItemEvent({ itemId: "p1", kind: "plan", title: "Plan", summary: "step one" });
    publisher.onItemEvent({ itemId: "life1", kind: "lifecycle", progressText: "internal state" });
    await publisher.finalize();

    expect(createActivityMessage.mock.calls).toMatchObject([
      [{ kind: "agent_commentary", body: "step one", provenance }],
    ]);
  });

  it("normalizes reasoning-style progress lanes into durable commentary rows", async () => {
    const { publisher, createActivityMessage, updateMessageBody } = createPublisher();

    publisher.onItemEvent({ itemId: "empty1", kind: "thinking", progressText: " " });
    const thinking = (progressText: string) =>
      commentary(progressText, { itemId: "think1", kind: "thinking" });
    publisher.onItemEvent(thinking("Checking"));
    await vi.advanceTimersByTimeAsync(700);
    publisher.onItemEvent(thinking("Checked"));
    publisher.onItemEvent(commentary("Comparing", { itemId: "r1", kind: "reasoning" }));
    publisher.onItemEvent({ itemId: "a1", kind: "analysis", summary: "Mapping" });
    await publisher.finalize();

    expect(createActivityMessage.mock.calls.map(([{ body, kind }]) => ({ body, kind }))).toEqual(
      ["Checking", "Comparing", "Mapping"].map((text) => ({
        body: `**Thinking**\n\n${text}`,
        kind: "agent_commentary",
      })),
    );
    expect(updateMessageBody).toHaveBeenCalledTimes(1);
    expect(updateMessageBody).toHaveBeenCalledWith("msg_1", "**Thinking**\n\nChecked");
  });
});
