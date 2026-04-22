import type { ChatStreamer } from "@slack/web-api/dist/chat-stream.js";
import { describe, expect, it, vi } from "vitest";
import { stopSlackStream, type SlackStreamSession } from "./streaming.js";

function makeSession(stopImpl: () => Promise<void>): SlackStreamSession {
  return {
    streamer: {
      append: vi.fn(async () => {}),
      stop: vi.fn(stopImpl),
    } as unknown as ChatStreamer,
    channel: "C123",
    threadTs: "1700000000.000100",
    stopped: false,
  };
}

function slackApiError(code: string): Error {
  const err = new Error(`An API error occurred: ${code}`);
  (err as unknown as { data: { error: string } }).data = { error: code };
  return err;
}

describe("stopSlackStream finalize error handling", () => {
  it("swallows user_not_found (Slack Connect DMs) and marks the session stopped", async () => {
    const session = makeSession(async () => {
      throw slackApiError("user_not_found");
    });
    await expect(stopSlackStream({ session })).resolves.toBeUndefined();
    expect(session.stopped).toBe(true);
  });

  it("swallows team_not_found (Slack Connect cross-workspace) and marks stopped", async () => {
    const session = makeSession(async () => {
      throw slackApiError("team_not_found");
    });
    await expect(stopSlackStream({ session })).resolves.toBeUndefined();
    expect(session.stopped).toBe(true);
  });

  it("swallows missing_recipient_user_id (DM closed mid-stream) and marks stopped", async () => {
    const session = makeSession(async () => {
      throw slackApiError("missing_recipient_user_id");
    });
    await expect(stopSlackStream({ session })).resolves.toBeUndefined();
    expect(session.stopped).toBe(true);
  });

  it("re-throws unexpected Slack API errors so callers can log them", async () => {
    const session = makeSession(async () => {
      throw slackApiError("not_authed");
    });
    await expect(stopSlackStream({ session })).rejects.toThrow(/not_authed/);
    // Session is still marked stopped so retries do not re-enter streamer.stop.
    expect(session.stopped).toBe(true);
  });

  it("re-throws non-Slack-shaped errors unchanged", async () => {
    const session = makeSession(async () => {
      throw new Error("socket reset");
    });
    await expect(stopSlackStream({ session })).rejects.toThrow(/socket reset/);
    expect(session.stopped).toBe(true);
  });

  it("returns a no-op on an already-stopped session", async () => {
    const stop = vi.fn(async () => {});
    const session: SlackStreamSession = {
      streamer: { append: vi.fn(async () => {}), stop } as unknown as ChatStreamer,
      channel: "C123",
      threadTs: "1700000000.000100",
      stopped: true,
    };
    await expect(stopSlackStream({ session })).resolves.toBeUndefined();
    expect(stop).not.toHaveBeenCalled();
  });
});
