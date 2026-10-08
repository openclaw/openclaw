import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramDirectAvatarResolver } from "./bot-message-avatar.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import type { TelegramContext } from "./bot/types.js";

vi.mock("./bot/delivery.resolve-media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot/delivery.resolve-media.js")>()),
  resolveMedia: vi.fn(),
}));
vi.mock("./bot-processing-outcome.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot-processing-outcome.js")>()),
  getTelegramSpooledReplayLifecycle: () => undefined,
}));

const photo = { file_id: "photo-one", file_unique_id: "unique-one", width: 160, height: 160 };
function context(id = 1000000001): Pick<TelegramContext, "message" | "me"> {
  return {
    me: telegramBotInfoForTest,
    message: {
      message_id: 1,
      date: 0,
      chat: { id, type: "private", first_name: "Riley" },
      from: { id, is_bot: false, first_name: "Riley" },
      text: "hello",
    },
  };
}
function account(accountId = "sample-bot") {
  const api = {
    getUserProfilePhotos: vi
      .fn<Parameters<typeof createTelegramDirectAvatarResolver>[0]["api"]["getUserProfilePhotos"]>()
      .mockResolvedValue({ total_count: 1, photos: [[photo]] }),
    getFile: vi.fn().mockResolvedValue({
      file_id: photo.file_id,
      file_unique_id: photo.file_unique_id,
      file_path: "photos/example.jpg",
    }),
  };
  return {
    api,
    resolve: createTelegramDirectAvatarResolver({ api, accountId, token: "test-token" }),
  };
}

beforeEach(() => {
  vi.mocked(resolveMedia).mockReset().mockResolvedValue({
    path: "/media/inbound/portrait.png",
    id: "portrait.png",
    fileUniqueId: "portrait-unique",
    size: 64,
    savedAt: 0,
    kind: "image",
    contentType: "image/png",
  });
});

describe("Telegram native direct portraits", () => {
  it("downloads through the existing account media policy and reuses the bounded native-peer cache", async () => {
    const { api, resolve } = account();
    const ctx = context();
    const before = structuredClone(ctx.message);
    expect(await resolve(ctx, {})).toBe("/media/inbound/portrait.png");
    expect(await resolve(ctx, {})).toBe("/media/inbound/portrait.png");
    expect(api.getUserProfilePhotos).toHaveBeenCalledOnce();
    expect(api.getUserProfilePhotos).toHaveBeenCalledWith(
      1000000001,
      { offset: 0, limit: 1 },
      expect.objectContaining({ aborted: false }),
    );
    expect(resolveMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "test-token",
        maxBytes: 256 * 1024,
        ctx: expect.objectContaining({ message: { photo: [photo] } }),
      }),
    );
    expect(ctx.message).toEqual(before);
  });

  it.each([false, true])(
    "removes the abort bridge after completion (failure=%s)",
    async (fails) => {
      const controller = new AbortController();
      const composedSignal = vi.spyOn(AbortSignal, "any").mockReturnValue(controller.signal);
      const removeListener = vi.spyOn(controller.signal, "removeEventListener");
      try {
        const { api, resolve } = account();
        if (fails) {
          api.getUserProfilePhotos.mockRejectedValueOnce(new Error("request failed"));
        }
        await resolve(context(), {});
        expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
      } finally {
        removeListener.mockRestore();
        composedSignal.mockRestore();
      }
    },
  );

  it("forwards native account cancellation to the grammY request", async () => {
    const controller = new AbortController();
    const { api } = account();
    const aborted = vi.fn();
    api.getUserProfilePhotos.mockImplementationOnce(async (_id, _options, signal) => {
      signal?.addEventListener("abort", aborted);
      controller.abort();
      throw new Error("request aborted");
    });
    const resolve = createTelegramDirectAvatarResolver({
      api,
      accountId: "sample-bot",
      token: "test-token",
      abortSignal: controller.signal,
    });
    expect(await resolve(context(), {})).toBeUndefined();
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(resolveMedia).not.toHaveBeenCalled();
  });

  it("clears a removed photo after the account cache expires", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const { api, resolve } = account();
      expect(await resolve(context(), {})).toBe("/media/inbound/portrait.png");
      clock.mockReturnValue(5 * 60 * 1000 + 1);
      api.getUserProfilePhotos.mockResolvedValueOnce({ total_count: 0, photos: [] });
      expect(await resolve(context(), {})).toBe("");
      expect(await resolve(context(), {})).toBe("");
      expect(api.getUserProfilePhotos).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("never shares native photos between senders or bot accounts", async () => {
    const first = account();
    const second = account("another-bot");
    await first.resolve(context(), {});
    await first.resolve(context(1000000002), {});
    await second.resolve(context(), {});
    expect(first.api.getUserProfilePhotos.mock.calls.map(([id]) => id)).toEqual([
      1000000001, 1000000002,
    ]);
    expect(second.api.getUserProfilePhotos).toHaveBeenCalledOnce();
    expect(resolveMedia).toHaveBeenCalledTimes(3);
  });

  it("keeps initials for absent, private, or unavailable photos", async () => {
    const { api, resolve } = account();
    api.getUserProfilePhotos.mockResolvedValueOnce({ total_count: 0, photos: [] });
    expect(await resolve(context(), {})).toBe("");
    api.getUserProfilePhotos.mockRejectedValueOnce(new Error("unavailable"));
    expect(await resolve(context(1000000002), {})).toBeUndefined();
    expect(resolveMedia).not.toHaveBeenCalled();
  });

  it("does not use a group photo, bot photo, or a private chat's different peer", async () => {
    const { api, resolve } = account();
    const ctx = context();
    expect(
      await resolve(
        { ...ctx, message: { ...ctx.message, chat: { id: -123, type: "group", title: "Group" } } },
        {},
      ),
    ).toBeUndefined();
    expect(
      await resolve(
        {
          ...ctx,
          message: { ...ctx.message, from: { id: 1000000002, is_bot: false, first_name: "Other" } },
        },
        {},
      ),
    ).toBeUndefined();
    expect(
      await resolve(
        {
          ...ctx,
          message: { ...ctx.message, from: { id: 1000000001, is_bot: true, first_name: "Bot" } },
        },
        {},
      ),
    ).toBeUndefined();
    expect(api.getUserProfilePhotos).not.toHaveBeenCalled();
  });
});
