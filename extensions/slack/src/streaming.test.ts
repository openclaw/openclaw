import { describe, expect, it, vi } from "vitest";
import type { ChatStreamer } from "@slack/web-api/dist/chat-stream.js";
import { stopSlackStream, type SlackStreamSession } from "./streaming.js";

function createSession() {
  const streamer = {
    stop: vi.fn(async () => undefined),
  } as unknown as ChatStreamer;

  const session: SlackStreamSession = {
    streamer,
    channel: "C123",
    threadTs: "123.456",
    stopped: false,
  };

  return { session, streamer };
}

describe("stopSlackStream", () => {
  it("passes undefined to stop when no final text or blocks are provided", async () => {
    const { session, streamer } = createSession();

    await stopSlackStream({ session });

    expect(streamer.stop).toHaveBeenCalledWith(undefined);
  });

  it("passes a payload to stop when final content is provided", async () => {
    const { session, streamer } = createSession();

    await stopSlackStream({
      session,
      text: "done",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "done" } }],
    });

    expect(streamer.stop).toHaveBeenCalledWith({
      markdown_text: "done",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "done" } }],
    });
  });
});
