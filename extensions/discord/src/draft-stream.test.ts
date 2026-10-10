// Discord tests cover draft stream plugin behavior.
import { MessageFlags, Routes } from "discord-api-types/v10";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createDiscordDraftStream } from "./draft-stream.js";

function createDraftRest() {
  return {
    post: vi.fn(async () => ({ id: "1001" })),
    patch: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

function createDraftStream(
  rest: ReturnType<typeof createDraftRest>,
  options: Partial<Omit<Parameters<typeof createDiscordDraftStream>[0], "rest">> = {},
) {
  return createDiscordDraftStream({
    rest: rest as never,
    channelId: "c1",
    throttleMs: 250,
    ...options,
  });
}

function createCurrentPreviewHarness(remove = vi.fn(async () => undefined)) {
  const rest = {
    post: vi.fn().mockResolvedValueOnce({ id: "1001" }).mockResolvedValueOnce({ id: "1002" }),
    patch: vi.fn(async () => undefined),
    delete: remove,
  };
  const warn = vi.fn();
  const stream = createDraftStream(rest, {
    warn,
  });
  return { rest, stream, warn };
}

describe("createDiscordDraftStream", () => {
  it("moves the visible draft to a newly adopted thread", async () => {
    const rest = {
      post: vi.fn().mockResolvedValueOnce({ id: "1101" }).mockResolvedValueOnce({ id: "1102" }),
      patch: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const stream = createDraftStream(rest, {
      channelId: "parent",
    });

    stream.update("working");
    await stream.flush();
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
    const rest = {
      post: vi
        .fn()
        .mockResolvedValueOnce({ id: "1101" })
        .mockRejectedValueOnce(new Error("thread post failed")),
      patch: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const stream = createDraftStream(rest, {
      channelId: "parent",
    });

    stream.update("working");
    await stream.flush();

    await expect(stream.retarget("thread-1")).rejects.toThrow("retarget replacement failed");
    expect(rest.delete).not.toHaveBeenCalled();

    await stream.cleanupPendingMessages();
    expect(rest.delete).toHaveBeenCalledWith("/channels/parent/messages/1101");
  });

  it("holds answer deltas below minInitialChars but sends a complete progress update", async () => {
    const rest = createDraftRest();
    const stream = createDraftStream(rest, {
      minInitialChars: 5,
    });

    stream.update("hey");
    await stream.flush();

    expect(rest.post).not.toHaveBeenCalled();
    expect(stream.messageId()).toBeUndefined();

    stream.update("hey", { complete: true });
    await stream.flush();
    expect(rest.post).toHaveBeenCalledTimes(1);
    await stream.deleteCurrentMessage();
    stream.update("hey");
    await stream.flush();
    expect(rest.post).toHaveBeenCalledTimes(1);
  });

  it("sends a reply preview, then edits the same message on later flushes", async () => {
    const rest = createDraftRest();
    const stream = createDraftStream(rest, {
      replyToMessageId: () => "  parent-1  ",
    });

    stream.update("first draft");
    await stream.flush();
    stream.update("second draft");
    await stream.flush();

    expect(rest.post).toHaveBeenCalledWith(Routes.channelMessages("c1"), {
      body: {
        content: "first draft",
        allowed_mentions: { parse: [] },
        message_reference: {
          message_id: "parent-1",
          fail_if_not_exists: false,
        },
      },
    });
    expect(rest.patch).toHaveBeenCalledWith(Routes.channelMessage("c1", "1001"), {
      body: { content: "second draft", allowed_mentions: { parse: [] } },
    });
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
      const { rest, stream } = createCurrentPreviewHarness(remove);

      stream.update("original preview");
      await stream.flush();
      const deleting = stream[method]();
      await deleteStarted.promise;
      await stream[method]();
      stream.forceNewMessage();
      stream.update("replacement preview");
      await stream.flush();
      finishDelete.resolve();
      await deleting;

      expect(rest.delete).toHaveBeenCalledExactlyOnceWith(Routes.channelMessage("c1", "1001"));
      expect(stream.messageId()).toBe("1002");
    },
  );

  it("does not clear a queued preview after awaiting the prior create", async () => {
    const createStarted = createDeferred<void>();
    const finishCreate = createDeferred<{ id: string }>();
    const { rest, stream } = createCurrentPreviewHarness();
    rest.post
      .mockReset()
      .mockImplementationOnce(async () => {
        createStarted.resolve();
        return await finishCreate.promise;
      })
      .mockResolvedValueOnce({ id: "1002" });

    stream.update("prior turn");
    await createStarted.promise;
    const clearing = stream.clear();
    stream.forceNewMessage("discard");
    stream.update("queued turn");
    finishCreate.resolve({ id: "1001" });
    await clearing;
    await stream.flush();

    expect(rest.delete).toHaveBeenCalledExactlyOnceWith(Routes.channelMessage("c1", "1001"));
    expect(stream.messageId()).toBe("1002");
  });

  it("suppresses link embeds in preview creates and edits when requested", async () => {
    const rest = createDraftRest();
    const stream = createDraftStream(rest, {
      suppressEmbeds: true,
    });

    stream.update("https://example.com");
    await stream.flush();
    stream.update("https://example.com/final");
    await stream.flush();

    expect(rest.post).toHaveBeenCalledWith(Routes.channelMessages("c1"), {
      body: {
        content: "https://example.com",
        allowed_mentions: { parse: [] },
        flags: MessageFlags.SuppressEmbeds,
      },
    });
    expect(rest.patch).toHaveBeenCalledWith(Routes.channelMessage("c1", "1001"), {
      body: {
        content: "https://example.com/final",
        allowed_mentions: { parse: [] },
        flags: MessageFlags.SuppressEmbeds,
      },
    });
  });

  it("stops previewing and warns once text exceeds the configured limit", async () => {
    const rest = createDraftRest();
    const warn = vi.fn();
    const stream = createDraftStream(rest, {
      maxChars: 5,
      warn,
    });

    stream.update("123456");
    await stream.flush();

    expect(rest.post).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("discord stream preview stopped (text length 6 > 5)");
    expect(stream.messageId()).toBeUndefined();
  });

  it("starts a new preview after a cleared turn is re-armed", async () => {
    const rest = {
      post: vi.fn().mockResolvedValueOnce({ id: "1001" }).mockResolvedValueOnce({ id: "1002" }),
      patch: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const stream = createDraftStream(rest);

    stream.update("first draft");
    await stream.flush();
    await stream.clear();
    stream.forceNewMessage();
    stream.update("queued turn draft");
    await stream.flush();

    expect(rest.post).toHaveBeenCalledTimes(2);
    expect(rest.delete).toHaveBeenCalledTimes(1);
    expect(stream.messageId()).toBe("1002");
  });

  it.each([
    { modes: ["preserve"] as const, discarded: false },
    { modes: ["discard"] as const, discarded: true },
    { modes: ["discard", "preserve"] as const, discarded: true },
    { modes: ["preserve", "discard"] as const, discarded: true },
  ])("settles an in-flight create after $modes rotations", async ({ modes, discarded }) => {
    const firstCreate = createDeferred<{ id: string }>();
    const rest = {
      post: vi.fn().mockReturnValueOnce(firstCreate.promise).mockResolvedValueOnce({ id: "1002" }),
      patch: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const stream = createDraftStream(rest);

    stream.update("old turn draft");
    expect(rest.post).toHaveBeenCalledTimes(1);
    for (const mode of modes) {
      stream.forceNewMessage(mode);
    }
    stream.update("queued turn draft");
    firstCreate.resolve({ id: "1001" });
    await stream.flush();

    expect(rest.post).toHaveBeenCalledTimes(2);
    expect(rest.post.mock.calls[1]?.[1]).toMatchObject({
      body: { content: "queued turn draft" },
    });
    if (discarded) {
      expect(rest.delete).toHaveBeenCalledExactlyOnceWith(Routes.channelMessage("c1", "1001"));
    } else {
      expect(rest.delete).not.toHaveBeenCalled();
    }
    expect(stream.messageId()).toBe("1002");
  });

  it("drops stale text restored by a failed in-flight send during rotation", async () => {
    let failFirstCreate: ((error: Error) => void) | undefined;
    const firstCreate = new Promise<{ id: string }>((_resolve, reject) => {
      failFirstCreate = reject;
    });
    const rest = {
      post: vi.fn().mockReturnValueOnce(firstCreate).mockResolvedValueOnce({ id: "1002" }),
      patch: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const stream = createDraftStream(rest);

    stream.update("stale turn draft");
    await vi.waitFor(() => expect(rest.post).toHaveBeenCalledTimes(1));
    stream.forceNewMessage("discard");
    stream.update("queued turn draft");
    failFirstCreate?.(new Error("send failed"));
    await stream.flush();

    expect(rest.post).toHaveBeenCalledTimes(2);
    expect(rest.post.mock.calls[1]?.[1]).toMatchObject({
      body: { content: "queued turn draft" },
    });
    expect(stream.messageId()).toBe("1002");
  });
});
