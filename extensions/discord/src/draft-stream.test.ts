import { MessageFlags, Routes } from "discord-api-types/v10";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createDiscordDraftStream } from "./draft-stream.js";

function createHarness(
  options: Partial<Omit<Parameters<typeof createDiscordDraftStream>[0], "rest">> = {},
  ids?: string[],
  remove = vi.fn(async () => undefined),
) {
  const post = vi.fn<() => Promise<{ id: string }>>();
  if (ids) {
    for (const id of ids) {
      post.mockResolvedValueOnce({ id });
    }
  } else {
    post.mockResolvedValue({ id: "1001" });
  }
  const rest = { post, patch: vi.fn(async () => undefined), delete: remove };
  const stream = createDiscordDraftStream({
    rest: rest as never,
    channelId: "c1",
    throttleMs: 250,
    ...options,
  });
  return { rest, stream };
}

async function flushText(stream: ReturnType<typeof createDiscordDraftStream>, text: string) {
  stream.update(text);
  await stream.flush();
}

function previewBody(content: string, extra = {}) {
  return { body: { content, allowed_mentions: { parse: [] }, ...extra } };
}

describe("createDiscordDraftStream", () => {
  it("moves the visible draft to a newly adopted thread", async () => {
    const { rest, stream } = createHarness({ channelId: "parent" }, ["1101", "1102"]);

    await flushText(stream, "working");
    stream.update("working harder");
    await stream.retarget("thread-1");

    expect(rest.delete).toHaveBeenCalledWith("/channels/parent/messages/1101");
    expect(rest.post).toHaveBeenLastCalledWith(
      "/channels/thread-1/messages",
      expect.objectContaining({ body: expect.objectContaining({ content: "working harder" }) }),
    );
    expect(stream.messageId()).toBe("1102");
  });

  it("keeps the parent draft when the thread replacement cannot be created", async () => {
    const { rest, stream } = createHarness({ channelId: "parent" }, ["1101"]);
    rest.post.mockRejectedValueOnce(new Error("thread post failed"));

    await flushText(stream, "working");

    await expect(stream.retarget("thread-1")).rejects.toThrow("retarget replacement failed");
    expect(rest.delete).not.toHaveBeenCalled();

    await stream.cleanupPendingMessages();
    expect(rest.delete).toHaveBeenCalledWith("/channels/parent/messages/1101");
  });

  it("holds answer deltas below minInitialChars but sends a complete progress update", async () => {
    const { rest, stream } = createHarness({ minInitialChars: 5 });

    await flushText(stream, "hey");

    expect(rest.post).not.toHaveBeenCalled();
    expect(stream.messageId()).toBeUndefined();

    stream.update("hey", { complete: true });
    await stream.flush();
    expect(rest.post).toHaveBeenCalledTimes(1);
    await stream.deleteCurrentMessage();
    await flushText(stream, "hey");
    expect(rest.post).toHaveBeenCalledTimes(1);
  });

  it("sends a reply preview, then edits the same message on later flushes", async () => {
    const { rest, stream } = createHarness({ replyToMessageId: () => "  parent-1  " });

    await flushText(stream, "first draft");
    await flushText(stream, "second draft");

    expect(rest.post).toHaveBeenCalledWith(
      Routes.channelMessages("c1"),
      previewBody("first draft", {
        message_reference: { message_id: "parent-1", fail_if_not_exists: false },
      }),
    );
    expect(rest.patch).toHaveBeenCalledWith(
      Routes.channelMessage("c1", "1001"),
      previewBody("second draft"),
    );
    expect(stream.messageId()).toBe("1001");
  });

  it.each(["clear", "deleteCurrentMessage"] as const)(
    "%s claims a preview once and preserves its replacement during deletion",
    async (method) => {
      const deleteStarted = createDeferred<void>();
      const finishDelete = createDeferred<void>();
      const remove = vi.fn(async () => {
        deleteStarted.resolve();
        await finishDelete.promise;
        return undefined;
      });
      const { rest, stream } = createHarness({}, ["1001", "1002"], remove);

      await flushText(stream, "original preview");
      const deleting = stream[method]();
      await deleteStarted.promise;
      await stream[method]();
      stream.forceNewMessage();
      await flushText(stream, "replacement preview");
      finishDelete.resolve();
      await deleting;

      expect(rest.delete).toHaveBeenCalledExactlyOnceWith(Routes.channelMessage("c1", "1001"));
      expect(stream.messageId()).toBe("1002");
    },
  );

  it("suppresses link embeds in preview creates and edits when requested", async () => {
    const { rest, stream } = createHarness({ suppressEmbeds: true });

    await flushText(stream, "https://example.com");
    await flushText(stream, "https://example.com/final");

    expect(rest.post).toHaveBeenCalledWith(
      Routes.channelMessages("c1"),
      previewBody("https://example.com", { flags: MessageFlags.SuppressEmbeds }),
    );
    expect(rest.patch).toHaveBeenCalledWith(
      Routes.channelMessage("c1", "1001"),
      previewBody("https://example.com/final", { flags: MessageFlags.SuppressEmbeds }),
    );
  });

  it("stops previewing and warns once text exceeds the configured limit", async () => {
    const warn = vi.fn();
    const { rest, stream } = createHarness({ maxChars: 5, warn });

    await flushText(stream, "123456");

    expect(rest.post).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("discord stream preview stopped (text length 6 > 5)");
    expect(stream.messageId()).toBeUndefined();
  });

  it("starts a new preview after a cleared turn is re-armed", async () => {
    const { rest, stream } = createHarness({}, ["1001", "1002"]);

    await flushText(stream, "first draft");
    await stream.clear();
    stream.forceNewMessage();
    await flushText(stream, "queued turn draft");

    expect(rest.post).toHaveBeenCalledTimes(2);
    expect(rest.delete).toHaveBeenCalledTimes(1);
    expect(stream.messageId()).toBe("1002");
  });
});
