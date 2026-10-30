import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveFeishuAccount } from "./accounts.js";
import { resolveFeishuSenderName } from "./bot-sender-name.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

const account = resolveFeishuAccount({
  accountId: "main",
  cfg: { channels: { feishu: { appId: "app-id", appSecret: "secret" } } },
});

function feishuApiError(code: number, message: string): Error {
  return Object.assign(new Error(message), {
    response: { data: { code, msg: message } },
  });
}

function mockUserNames(...names: (string | Error)[]): ReturnType<typeof vi.fn> {
  const get = vi.fn();
  for (const name of names) {
    if (name instanceof Error) {
      get.mockRejectedValueOnce(name);
    } else {
      get.mockResolvedValueOnce({ data: { user: { name } } });
    }
  }
  createFeishuClientMock.mockReturnValue({
    contact: { user: { get } },
  });
  return get;
}

const resolve = (senderId: string, log = vi.fn(), selectedAccount = account) =>
  resolveFeishuSenderName({ account: selectedAccount, senderId, log });
const mockUnauthorizedLookup = () =>
  mockUserNames(feishuApiError(41050, "no user authority error"), "Ada");

describe("resolveFeishuSenderName", () => {
  afterEach(() => {
    vi.useRealTimers();
    createFeishuClientMock.mockReset();
  });

  it.each(["resolved", "account-scoped miss", "expired miss"] as const)(
    "caches sender lookup: %s",
    async (scenario) => {
      vi.useFakeTimers();
      const resolved = scenario === "resolved";
      const get = resolved ? mockUserNames("Ada") : mockUnauthorizedLookup();
      const first = resolved ? { name: "Ada" } : {};
      const sender = `ou_${scenario}`;
      const log = vi.fn();
      await expect(resolve(sender, log)).resolves.toEqual(first);
      await expect(resolve(sender, log)).resolves.toEqual(first);
      expect(get).toHaveBeenCalledTimes(1);
      if (scenario === "expired miss") {
        vi.advanceTimersByTime(30 * 60 * 1000 + 1);
      }
      const selected =
        scenario === "account-scoped miss" ? { ...account, accountId: "secondary" } : account;
      await expect(resolve(sender, log, selected)).resolves.toEqual({ name: "Ada" });
      expect(get).toHaveBeenCalledTimes(resolved ? 1 : 2);
      expect(log).not.toHaveBeenCalled();
    },
  );

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
    const callsFor = (id: string) =>
      get.mock.calls.filter(([params]) => params.path.user_id === id);
    expect(callsFor("ou_sender_cap_0")).toHaveLength(2);
    expect(callsFor("ou_sender_cap_500")).toHaveLength(1);
  });
});
