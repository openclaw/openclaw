import { WebClient } from "@slack/web-api";
import { ChatStreamer } from "@slack/web-api/dist/chat-stream.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { getSlackListenerWriteClient } from "./client.js";
import {
  appendSlackStream,
  markSlackStreamFallbackDelivered,
  markSlackStreamsStopped,
  SlackStreamNotDeliveredError,
  startSlackStream,
  stopSlackStream,
  type SlackStreamSession,
} from "./streaming.js";

type StopImpl = (args?: unknown) => Promise<unknown>;
const target = { channel: "C123", threadTs: "1700000000.000100" };
const streamTs = "1700000000.500300";
const stoppedPayload = { token: undefined, channel: "C123", ts: streamTs, chunks: [] };

function makeSession(stopImpl: StopImpl = async () => {}): SlackStreamSession {
  return {
    streamer: {
      append: vi.fn(async () => null),
      stop: vi.fn(stopImpl),
    } as unknown as ChatStreamer,
    ...target,
    stopped: false,
    delivered: false,
    pendingText: "",
  };
}

function slackApiError(code: string): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });
}

function createNativeStreamClient() {
  const client = new WebClient("xoxb-synthetic");
  const writeClient = getSlackListenerWriteClient({ listenerClient: client });
  if (!writeClient) {
    throw new Error("missing synthetic stream writer");
  }
  const start = vi
    .spyOn(writeClient.chat, "startStream")
    .mockResolvedValue({ ok: true, ts: streamTs });
  const append = vi.spyOn(writeClient.chat, "appendStream").mockResolvedValue({ ok: true });
  const stop = vi.spyOn(writeClient.chat, "stopStream").mockResolvedValue({ ok: true });
  return { client, start, append, stop };
}

function startTextStream(client: WebClient, text: string) {
  return startSlackStream({ client, ...target, text, chunks: [] });
}

function createBufferedSession(bufferSize: number) {
  const startStream = vi.fn(async () => ({ ok: true, ts: streamTs }));
  const stopStream = vi.fn(async () => ({ ok: true, ts: streamTs }));
  const client = {
    chat: { startStream, appendStream: vi.fn(async () => ({ ok: true })), stopStream },
  };
  const session = makeSession();
  session.streamer = new ChatStreamer(
    client as never,
    { debug: vi.fn() } as never,
    { channel: session.channel, thread_ts: session.threadTs },
    { buffer_size: bufferSize },
  );
  return { session, startStream, stopStream };
}

describe("stopSlackStream finalize error handling", () => {
  it("discards a Slack-stopped stream's buffered tail without flushing or falling back", async () => {
    const { client, append, stop } = createNativeStreamClient();
    const session = await startTextStream(client, "visible text");
    await appendSlackStream({ session, text: "buffered tail" });
    markSlackStreamsStopped(new WebClient("xoxb-other"), "C123", ["1700000000.500300"]);
    expect(session.stopped).toBe(false);

    markSlackStreamsStopped(client, "C123", ["1700000000.500300"]);
    await appendSlackStream({ session, text: "late final", chunks: [] });
    markSlackStreamFallbackDelivered(session);
    await expect(stopSlackStream({ session })).resolves.toEqual({});

    expect(session).toMatchObject({
      stopped: true,
      stoppedBySlack: true,
      delivered: true,
      pendingText: "buffered tail",
    });
    expect(append).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("honors Stop received before the initial start response reveals the stream timestamp", async () => {
    const { client, start, stop } = createNativeStreamClient();
    const response = createDeferred<{ ok: boolean; ts: string }>();
    start.mockReturnValueOnce(response.promise);
    const starting = startTextStream(client, "initial text");
    expect(start).toHaveBeenCalledOnce();
    markSlackStreamsStopped(client, "C123", ["1700000000.500300"]);
    response.resolve({ ok: true, ts: "1700000000.500300" });

    const session = await starting;
    await stopSlackStream({ session });

    expect(session.stoppedBySlack).toBe(true);
    expect(stop).not.toHaveBeenCalled();
  });

  it.each([
    { operation: "append", matches: true },
    { operation: "stop", matches: true },
    { operation: "append", matches: false },
    { operation: "stop", matches: false },
  ] as const)(
    "only suppresses in-flight $operation errors for a matching Stop event ($matches)",
    async ({ operation, matches }) => {
      const { client, append, stop } = createNativeStreamClient();
      const session = await startTextStream(client, "visible text");
      const response = createDeferred<{ ok: boolean }>();
      const method = operation === "append" ? append : stop;
      method.mockReturnValueOnce(response.promise);
      const pending =
        operation === "append"
          ? appendSlackStream({ session, text: "pending tail", chunks: [] })
          : stopSlackStream({ session });
      expect(method).toHaveBeenCalledOnce();
      markSlackStreamsStopped(client, matches ? "C123" : "C_OTHER", ["1700000000.500300"]);
      const error = slackApiError("internal_error");
      response.reject(error);

      if (matches) {
        await pending;
        expect(session.stoppedBySlack).toBe(true);
        expect(session.pendingText).toBe(operation === "append" ? "pending tail" : "");
      } else {
        await expect(pending).rejects.toBe(error);
        expect(session.stoppedBySlack).toBeUndefined();
      }
    },
  );

  it("starts and appends supported structured stream chunks without buffering markdown text", async () => {
    const { client, start } = createNativeStreamClient();
    const chunks = [{ type: "plan_update" as const, title: "Inspecting" }];

    const session = await startSlackStream({
      client,
      ...target,
      chunks,
      taskDisplayMode: "plan",
      identity: { username: "Research Agent", iconEmoji: ":mag:" },
    });

    expect(start).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "1700000000.000100",
      task_display_mode: "plan",
      username: "Research Agent",
      icon_emoji: ":mag:",
      token: undefined,
      chunks,
    });
    expect(session).toMatchObject({ delivered: true, pendingText: "" });
  });

  it("throws SlackStreamNotDeliveredError for unexpected finalize codes while text is buffered", async () => {
    const session = makeSession(async () => {
      throw slackApiError("method_not_supported_for_channel_type");
    });
    await appendSlackStream({ session, text: "short thread reply" });

    const thrown = await stopSlackStream({ session }).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(SlackStreamNotDeliveredError);
    expect(thrown).toMatchObject({
      slackCode: "method_not_supported_for_channel_type",
      pendingText: "short thread reply",
    });
  });

  it("does not retry ambiguous transport failures while text is buffered", async () => {
    const session = makeSession(async () => {
      throw new Error("socket reset");
    });
    await appendSlackStream({ session, text: "locally buffered reply" });

    await expect(stopSlackStream({ session })).rejects.toThrow("socket reset");
    expect(session.pendingText).toBe("locally buffered reply");
  });

  it("does not replay an ambiguous append through later append or stop", async () => {
    const error = new Error("socket reset");
    const { client, append, stop } = createNativeStreamClient();
    const session = await startTextStream(client, "acknowledged prefix");
    await appendSlackStream({ session, text: "buffered suffix" });
    append.mockRejectedValueOnce(error);

    await expect(appendSlackStream({ session, text: " final suffix", chunks: [] })).rejects.toBe(
      error,
    );
    await appendSlackStream({ session, text: "late final", chunks: [] });
    await stopSlackStream({ session });

    expect(append).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        chunks: [{ type: "markdown_text", text: "buffered suffix final suffix" }],
      }),
    );
    expect(stop).not.toHaveBeenCalled();
    expect(session.pendingText).toBe("buffered suffix final suffix");
  });

  it("preserves only the rejected tail and tolerates finalize after team_not_found fallback", async () => {
    const { client, append, stop } = createNativeStreamClient();
    const session = await startTextStream(client, "already visible");
    append.mockRejectedValue(slackApiError("team_not_found"));
    stop.mockRejectedValue(slackApiError("team_not_found"));
    const rejectedTail = { name: "SlackStreamNotDeliveredError", pendingText: "pending tail" };

    await expect(
      appendSlackStream({ session, text: "pending tail", chunks: [] }),
    ).rejects.toMatchObject(rejectedTail);
    await expect(stopSlackStream({ session })).rejects.toMatchObject(rejectedTail);
    markSlackStreamFallbackDelivered(session);
    await expect(stopSlackStream({ session })).resolves.toEqual({});
    await expect(stopSlackStream({ session })).resolves.toEqual({});
    expect(stop).toHaveBeenCalledTimes(2);
    expect(stop.mock.calls[1]?.[0]).not.toHaveProperty("markdown_text");
    expect(session).toMatchObject({ stopped: true, delivered: true, pendingText: "" });
  });

  it.each([
    {
      name: "message.ts",
      response: { ok: true, message: { ts: "1700000000.500200" } },
      expected: { messageId: "1700000000.500200" },
    },
    { name: "no timestamp", response: { ok: true }, expected: {} },
  ])("finalizes a response with $name", async ({ response, expected }) => {
    const session = makeSession(async () => response);
    await appendSlackStream({ session, text: "short" });
    await expect(stopSlackStream({ session })).resolves.toEqual(expected);
  });

  it("preserves pending text when start rejects with missing_scope", async () => {
    const { client, start } = createNativeStreamClient();
    start.mockRejectedValueOnce(slackApiError("missing_scope"));

    const thrown = await startTextStream(client, "initial chunk that flushes immediately").catch(
      (err: unknown) => err,
    );

    expect(thrown).toBeInstanceOf(SlackStreamNotDeliveredError);
    expect(thrown).toHaveProperty("pendingText", "initial chunk that flushes immediately");
  });

  it.each([false, true])(
    "retires fallback sessions according to prior delivery: %s",
    (delivered) => {
      const session = makeSession();
      session.delivered = delivered;
      markSlackStreamFallbackDelivered(session);
      expect(session).toMatchObject({ delivered, pendingText: "", stopped: !delivered });
    },
  );

  it("does not resend committed text when finalization rejects after delivery", async () => {
    const { session, startStream, stopStream } = createBufferedSession(256);
    stopStream.mockRejectedValue(slackApiError("user_not_found"));
    const metadata = { event_type: "openclaw.reply", event_payload: { turn: "qa" } };

    await appendSlackStream({ session, text: "short committed reply", chunks: [] });
    await expect(stopSlackStream({ session, metadata })).resolves.toEqual({});
    await expect(stopSlackStream({ session, metadata })).resolves.toEqual({});

    expect(startStream).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        chunks: [{ type: "markdown_text", text: "short committed reply" }],
      }),
    );
    expect(stopStream).toHaveBeenCalledExactlyOnceWith({ ...stoppedPayload, metadata });
    expect(session).toMatchObject({ stopped: true, delivered: true, pendingText: "" });
  });

  it("clears the SDK buffer before finalizing an already-visible fallback stream", async () => {
    const { session, startStream, stopStream } = createBufferedSession(10);

    await appendSlackStream({ session, text: "already visible" });
    await appendSlackStream({ session, text: "tail" });
    expect(session).toMatchObject({ delivered: true, pendingText: "tail" });

    markSlackStreamFallbackDelivered(session);
    await stopSlackStream({ session });

    expect(startStream).toHaveBeenCalledOnce();
    expect(stopStream).toHaveBeenCalledWith(stoppedPayload);
  });
});
