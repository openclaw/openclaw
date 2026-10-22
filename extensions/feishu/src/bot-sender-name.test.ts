import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveFeishuSenderName } from "./bot-sender-name.js";
import { FeishuConfigSchema } from "./config-schema.js";
import type { ResolvedFeishuAccount } from "./types.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

const account = {
  accountId: "main",
  enabled: true,
  configured: true,
  appId: "app-id",
  appSecret: "secret",
  domain: "feishu",
  config: FeishuConfigSchema.parse({}),
} satisfies ResolvedFeishuAccount;

function feishuApiError(code: number, message: string): Error {
  return Object.assign(new Error(message), {
    response: { data: { code, msg: message } },
  });
}

function mockUserNames(...names: string[]): ReturnType<typeof vi.fn> {
  const get = vi.fn();
  for (const name of names) {
    get.mockResolvedValueOnce({ data: { user: { name } } });
  }
  createFeishuClientMock.mockReturnValue({
    contact: { user: { get } },
  });
  return get;
}

const resolve = (senderId: string, log = vi.fn(), selectedAccount = account) =>
  resolveFeishuSenderName({ account: selectedAccount, senderId, log });
function mockUnauthorizedLookup() {
  const get = vi
    .fn()
    .mockRejectedValueOnce(feishuApiError(41050, "no user authority error"))
    .mockResolvedValueOnce({ data: { user: { name: "Ada" } } });
  createFeishuClientMock.mockReturnValue({ contact: { user: { get } } });
  return get;
}

describe("resolveFeishuSenderName", () => {
  afterEach(() => {
    vi.useRealTimers();
    createFeishuClientMock.mockReset();
  });

  it("reuses a cached sender name within the TTL", async () => {
    const get = mockUserNames("Ada");

    await expect(resolve("ou_sender_cache")).resolves.toEqual({ name: "Ada" });
    await expect(resolve("ou_sender_cache")).resolves.toEqual({ name: "Ada" });

    expect(get).toHaveBeenCalledTimes(1);
  });

  it("caches 41050 misses per account without logging another failure", async () => {
    const get = mockUnauthorizedLookup();
    const log = vi.fn();

    await expect(resolve("ou_sender_hidden", log)).resolves.toEqual({});
    await expect(resolve("ou_sender_hidden", log)).resolves.toEqual({});
    await expect(
      resolve("ou_sender_hidden", log, { ...account, accountId: "secondary" }),
    ).resolves.toEqual({ name: "Ada" });

    expect(get).toHaveBeenCalledTimes(2);
    expect(log).not.toHaveBeenCalled();
  });

  it("retries a 41050 sender lookup after the negative cache expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    const get = mockUnauthorizedLookup();

    await expect(resolve("ou_sender_retry")).resolves.toEqual({});
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    await expect(resolve("ou_sender_retry")).resolves.toEqual({ name: "Ada" });

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("continues logging and retrying sender lookup failures other than 41050", async () => {
    const error = feishuApiError(41051, "different lookup error");
    const get = vi.fn().mockRejectedValue(error);
    createFeishuClientMock.mockReturnValue({ contact: { user: { get } } });
    const log = vi.fn();

    await resolve("ou_sender_other_error", log);
    await resolve("ou_sender_other_error", log);

    expect(get).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest sender while retaining recent sender names", async () => {
    const get = vi.fn(async (params: { path: { user_id: string } }) => ({
      data: { user: { name: `name-${params.path.user_id}` } },
    }));
    createFeishuClientMock.mockReturnValue({ contact: { user: { get } } });

    for (let index = 0; index < 501; index += 1) {
      await resolve(`ou_sender_cap_${index}`);
    }
    await resolve("ou_sender_cap_0");
    await resolve("ou_sender_cap_500");

    expect(get).toHaveBeenCalledTimes(502);
    expect(
      get.mock.calls.filter(([params]) => params.path.user_id === "ou_sender_cap_0"),
    ).toHaveLength(2);
    expect(
      get.mock.calls.filter(([params]) => params.path.user_id === "ou_sender_cap_500"),
    ).toHaveLength(1);
  });
});
