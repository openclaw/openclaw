import { describe, expect, it, vi } from "vitest";
import {
  appendSlackPlanMessage,
  startSlackPlanMessage,
  stopSlackPlanMessage,
  type SlackStreamChunk,
} from "./streaming.js";

describe("slack plan message fallback", () => {
  it("posts and updates a normal plan block message", async () => {
    const apiCall = vi.fn(async (method: string) => ({
      ok: true,
      ts: method === "chat.postMessage" ? "171234.100" : undefined,
    }));
    const client = { apiCall };
    const initialChunks: SlackStreamChunk[] = [
      {
        type: "task_update",
        id: "reading_message",
        title: "Reading message",
        status: "in_progress",
      },
    ];

    const session = await startSlackPlanMessage({
      client: client as never,
      channel: "D123",
      chunks: initialChunks,
    });

    expect(session.messageTs).toBe("171234.100");
    expect(apiCall).toHaveBeenCalledWith(
      "chat.postMessage",
      expect.objectContaining({
        channel: "D123",
        text: "Thinking...\n- now: Reading message",
        blocks: [
          expect.objectContaining({
            type: "plan",
            title: "Reading message",
            tasks: [
              {
                type: "task_card",
                task_id: "reading_message",
                title: "Reading message",
                status: "in_progress",
              },
            ],
          }),
        ],
      }),
    );

    await appendSlackPlanMessage({
      session,
      chunks: [
        {
          type: "task_update",
          id: "deciding_next_steps",
          title: "Deciding on next steps",
          status: "in_progress",
        },
        {
          type: "task_update",
          id: "reading_message",
          title: "Reading message",
          status: "complete",
        },
      ],
    });

    expect(apiCall).toHaveBeenLastCalledWith(
      "chat.update",
      expect.objectContaining({
        channel: "D123",
        ts: "171234.100",
        blocks: [
          expect.objectContaining({
            title: "Deciding on next steps",
            tasks: [
              expect.objectContaining({
                task_id: "reading_message",
                status: "complete",
              }),
              expect.objectContaining({
                task_id: "deciding_next_steps",
                status: "in_progress",
              }),
            ],
          }),
        ],
      }),
    );

    await stopSlackPlanMessage({ session });

    expect(apiCall).toHaveBeenLastCalledWith(
      "chat.update",
      expect.objectContaining({
        channel: "D123",
        text: "Thinking completed.\n- done: Reading message\n- now: Deciding on next steps",
        ts: "171234.100",
        blocks: [
          expect.objectContaining({
            title: "Thinking completed",
          }),
        ],
      }),
    );
  });

  it("can post the plan message inside an existing assistant thread", async () => {
    const apiCall = vi.fn(async (method: string) => ({
      ok: true,
      ts: method === "chat.postMessage" ? "171234.150" : undefined,
    }));
    const client = { apiCall };

    const session = await startSlackPlanMessage({
      client: client as never,
      channel: "D123",
      threadTs: "171234.001",
      chunks: [
        {
          type: "task_update",
          id: "reading_message",
          title: "Reading message",
          status: "in_progress",
        },
      ],
    });

    expect(session.messageTs).toBe("171234.150");
    expect(apiCall).toHaveBeenCalledWith(
      "chat.postMessage",
      expect.objectContaining({
        channel: "D123",
        thread_ts: "171234.001",
        text: "Thinking...\n- now: Reading message",
      }),
    );
  });

  it("can render a plain text progress message for DM-safe fallback", async () => {
    const apiCall = vi.fn(async (method: string) => ({
      ok: true,
      ts: method === "chat.postMessage" ? "171234.200" : undefined,
    }));
    const client = { apiCall };

    const session = await startSlackPlanMessage({
      client: client as never,
      channel: "D123",
      renderMode: "text",
      chunks: [
        {
          type: "task_update",
          id: "reading_message",
          title: "Reading message",
          status: "in_progress",
        },
      ],
    });

    expect(session.messageTs).toBe("171234.200");
    expect(apiCall).toHaveBeenCalledWith("chat.postMessage", {
      channel: "D123",
      text: "Thinking...\n- now: Reading message",
    });

    await appendSlackPlanMessage({
      session,
      chunks: [
        {
          type: "task_update",
          id: "reading_message",
          title: "Reading message",
          status: "complete",
        },
        {
          type: "task_update",
          id: "sending_reply",
          title: "Sending reply",
          status: "in_progress",
        },
      ],
    });

    expect(apiCall).toHaveBeenLastCalledWith("chat.update", {
      channel: "D123",
      ts: "171234.200",
      text: "Thinking...\n- done: Reading message\n- now: Sending reply",
    });
  });
});
