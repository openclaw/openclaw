import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTelegramDirectAvatarResolver } from "./bot-message-avatar.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import type { TelegramContext } from "./bot/types.js";

vi.mock("./bot/delivery.resolve-media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot/delivery.resolve-media.js")>()),
  resolveMedia: vi.fn(),
}));

const file = { file_id: "photo-one", file_unique_id: "unique-one" };
const photo = { ...file, width: 160, height: 160 };
type Context = Pick<TelegramContext, "message" | "me">;
function context(id = 1000000001, overrides: Partial<Context["message"]> = {}): Context {
  return {
    me: telegramBotInfoForTest,
    message: {
      message_id: 1,
      date: 0,
      chat: { id, type: "private", first_name: "Riley" },
      from: { id, is_bot: false, first_name: "Riley" },
      text: "hello",
      ...overrides,
    },
  };
}
function account(accountId = "sample-bot", abortSignal?: AbortSignal) {
  const api = {
    getUserProfilePhotos: vi
      .fn<Parameters<typeof createTelegramDirectAvatarResolver>[0]["api"]["getUserProfilePhotos"]>()
      .mockResolvedValue({ total_count: 1, photos: [[photo]] }),
    getFile: vi.fn().mockResolvedValue({ ...file, file_path: "photos/example.jpg" }),
  };
  const params = { api, accountId, token: "test-token", abortSignal };
  return { api, resolve: createTelegramDirectAvatarResolver(params) };
}
async function load(get: ReturnType<typeof account>["resolve"], ctx = context(), initial?: string) {
  expect(get(ctx, {})).toBe(initial);
  await vi.advanceTimersByTimeAsync(0);
  return get(ctx, {});
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(resolveMedia).mockReset().mockResolvedValue({
    path: "/media/inbound/portrait.png",
    id: "portrait.png",
    fileUniqueId: "portrait-unique",
    size: 64,
    savedAt: 0,
    kind: "image",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("returns immediately while a cold portrait request is pending", () => {
  const { api, resolve } = account();
  api.getUserProfilePhotos.mockReturnValueOnce(new Promise(() => {}));
  expect(resolve(context(), {})).toBeUndefined();
  expect(resolve(context(), {})).toBeUndefined();
  expect(api.getUserProfilePhotos).toHaveBeenCalledOnce();
  expect(resolveMedia).not.toHaveBeenCalled();
});

it("downloads through the existing account media policy and reuses the bounded native-peer cache", async () => {
  const { api, resolve } = account();
  const ctx = context();
  const before = structuredClone(ctx.message);
  expect(await load(resolve, ctx)).toBe("/media/inbound/portrait.png");
  expect(api.getUserProfilePhotos).toHaveBeenCalledExactlyOnceWith(
    1000000001,
    { offset: 0, limit: 1 },
    expect.objectContaining({ aborted: false }),
  );
  expect(vi.mocked(resolveMedia).mock.calls[0]?.[0]).toMatchObject({
    token: "test-token",
    maxBytes: 256 * 1024,
    ctx: expect.objectContaining({ message: { photo: [photo] } }),
  });
  expect(ctx.message).toEqual(before);
});

it.each([false, true])("removes the abort bridge (failure=%s)", async (fails) => {
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "any").mockReturnValue(controller.signal);
  const removeListener = vi.spyOn(controller.signal, "removeEventListener");
  const { api, resolve } = account();
  if (fails) {
    api.getUserProfilePhotos.mockRejectedValueOnce(new Error("request failed"));
  }
  expect(await load(resolve)).toBe(fails ? undefined : "/media/inbound/portrait.png");
  if (fails) {
    expect(resolveMedia).not.toHaveBeenCalled();
  }
  expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
});

it("forwards native account cancellation to the grammY request", async () => {
  const controller = new AbortController();
  const { api, resolve } = account("sample-bot", controller.signal);
  const aborted = vi.fn();
  api.getUserProfilePhotos.mockImplementationOnce(async (_id, _options, signal) => {
    signal?.addEventListener("abort", aborted);
    controller.abort();
    throw new Error("request aborted");
  });
  await load(resolve);
  expect(aborted).toHaveBeenCalledTimes(1);
  expect(resolveMedia).not.toHaveBeenCalled();
});

it("clears a removed photo after the account cache expires", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(0);
  const { api, resolve } = account();
  expect(await load(resolve)).toBe("/media/inbound/portrait.png");
  clock.mockReturnValue(5 * 60 * 1000 + 1);
  api.getUserProfilePhotos.mockResolvedValueOnce({ total_count: 0, photos: [] });
  expect(await load(resolve, context(), "/media/inbound/portrait.png")).toBe("");
  expect(api.getUserProfilePhotos).toHaveBeenCalledTimes(2);
});

it("never shares native photos between senders or bot accounts", async () => {
  const first = account();
  const second = account("another-bot");
  first.resolve(context(), {});
  first.resolve(context(1000000002), {});
  second.resolve(context(), {});
  await vi.advanceTimersByTimeAsync(0);
  expect(first.api.getUserProfilePhotos.mock.calls.map(([id]) => id)).toEqual([
    1000000001, 1000000002,
  ]);
  expect(second.api.getUserProfilePhotos).toHaveBeenCalledOnce();
  expect(resolveMedia).toHaveBeenCalledTimes(3);
});

it("does not use a group photo, bot photo, or a private chat's different peer", () => {
  const { api, resolve } = account();
  const rejected: Partial<TelegramContext["message"]>[] = [
    { chat: { id: -123, type: "group", title: "Group" } },
    { from: { id: 1000000002, is_bot: false, first_name: "Other" } },
    { from: { id: 1000000001, is_bot: true, first_name: "Bot" } },
  ];
  for (const message of rejected) {
    expect(resolve(context(1000000001, message), {})).toBeUndefined();
  }
  expect(api.getUserProfilePhotos).not.toHaveBeenCalled();
});
