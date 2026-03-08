import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendMessageSignal } from "./send.js";

const rpcMock = vi.fn();

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

vi.mock("./accounts.js", () => ({
  resolveSignalAccount: () => ({
    accountId: "default",
    enabled: true,
    baseUrl: "http://signal.local",
    configured: true,
    config: { account: "+15550001111" },
  }),
}));

vi.mock("./client.js", () => ({
  signalRpcRequest: (...args: unknown[]) => rpcMock(...args),
}));

describe("sendMessageSignal", () => {
  beforeEach(() => {
    rpcMock.mockReset().mockResolvedValue({ timestamp: 123 });
  });

  it("sends quote-author for group replies when quoteAuthor is available", async () => {
    await sendMessageSignal("group:test-group", "hello", {
      textMode: "plain",
      replyTo: "1700000000000",
      quoteAuthor: "uuid:sender-1",
    });

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(rpcMock).toHaveBeenCalledWith("send", expect.any(Object), expect.any(Object));
    expect(params.groupId).toBe("test-group");
    expect(params["quote-timestamp"]).toBe(1700000000000);
    expect(params["quote-author"]).toBe("uuid:sender-1");
  });

  it("sends quote-timestamp for direct replies without quoteAuthor", async () => {
    await sendMessageSignal("+15551230000", "hello", {
      textMode: "plain",
      replyTo: "1700000000000",
    });

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params["quote-timestamp"]).toBe(1700000000000);
    expect(params["quote-author"]).toBeUndefined();
  });

  it("ignores replyTo values with trailing non-numeric characters", async () => {
    await sendMessageSignal("+15551230000", "hello", {
      textMode: "plain",
      replyTo: "1700000000000abc",
      quoteAuthor: "uuid:sender-1",
    });

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params["quote-timestamp"]).toBeUndefined();
    expect(params["quote-author"]).toBeUndefined();
  });

  it("skips group quote metadata when quoteAuthor is unavailable", async () => {
    await sendMessageSignal("group:test-group", "hello", {
      textMode: "plain",
      replyTo: "1700000000000",
    });

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params["quote-timestamp"]).toBeUndefined();
    expect(params["quote-author"]).toBeUndefined();
  });
});
