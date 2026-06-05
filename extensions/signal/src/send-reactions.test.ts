// Signal tests cover send reactions plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
const rememberSignalSelfReplyEchoMock = vi.hoisted(() => vi.fn());
const forgetSignalSelfReplyEchoMock = vi.hoisted(() => vi.fn());
const discoverSignalAccountUuidMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<string | undefined>>(async () => undefined),
);
const resolvedSignalAccountConfig = vi.hoisted(() => ({
  current: { account: "+15550001111" } as Record<string, unknown>,
}));

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/plugin-config-runtime")>(
    "openclaw/plugin-sdk/plugin-config-runtime",
  );
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
    config: resolvedSignalAccountConfig.current,
  }),
}));

vi.mock("./client-adapter.js", () => ({
  signalRpcRequest: (...args: unknown[]) => rpcMock(...args),
}));

vi.mock("./account-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./account-store.js")>();
  return {
    ...actual,
    discoverSignalAccountUuid: (...args: unknown[]) => discoverSignalAccountUuidMock(...args),
  };
});

vi.mock("./self-reply-echoes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./self-reply-echoes.js")>();
  return {
    ...actual,
    forgetSignalSelfReplyEcho: (...args: unknown[]) => forgetSignalSelfReplyEchoMock(...args),
    rememberSignalSelfReplyEcho: (...args: unknown[]) => rememberSignalSelfReplyEchoMock(...args),
  };
});

let sendReactionSignal: typeof import("./send-reactions.js").sendReactionSignal;
let removeReactionSignal: typeof import("./send-reactions.js").removeReactionSignal;

const SIGNAL_TEST_CFG = {
  channels: {
    signal: {
      accounts: {
        default: {},
      },
    },
  },
};

function requireRpcParams(): Record<string, unknown> {
  const [call] = rpcMock.mock.calls;
  if (!call) {
    throw new Error("expected Signal RPC call");
  }
  const [, params] = call;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("expected Signal RPC params");
  }
  return params as Record<string, unknown>;
}

describe("sendReactionSignal", () => {
  beforeAll(async () => {
    ({ sendReactionSignal, removeReactionSignal } = await import("./send-reactions.js"));
  });

  beforeEach(() => {
    rpcMock.mockClear().mockResolvedValue({ timestamp: 123 });
    rememberSignalSelfReplyEchoMock.mockReset();
    forgetSignalSelfReplyEchoMock.mockReset();
    discoverSignalAccountUuidMock.mockReset().mockResolvedValue(undefined);
    resolvedSignalAccountConfig.current = { account: "+15550001111" };
  });

  it("uses recipients array and targetAuthor for uuid dms", async () => {
    await sendReactionSignal("uuid:123e4567-e89b-12d3-a456-426614174000", 123, "🔥", {
      cfg: SIGNAL_TEST_CFG,
    });

    expect(rpcMock).toHaveBeenCalledWith(
      "sendReaction",
      {
        emoji: "🔥",
        targetTimestamp: 123,
        targetAuthor: "123e4567-e89b-12d3-a456-426614174000",
        recipients: ["123e4567-e89b-12d3-a456-426614174000"],
        account: "+15550001111",
      },
      {
        baseUrl: "http://signal.local",
        timeoutMs: undefined,
        apiMode: undefined,
      },
    );
    const params = requireRpcParams();
    expect(params.recipients).toEqual(["123e4567-e89b-12d3-a456-426614174000"]);
    expect(params.groupIds).toBeUndefined();
    expect(params.targetAuthor).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(params).not.toHaveProperty("recipient");
    expect(params).not.toHaveProperty("groupId");
  });

  it("uses groupIds array and maps targetAuthorUuid", async () => {
    await sendReactionSignal("", 123, "✅", {
      cfg: SIGNAL_TEST_CFG,
      groupId: "group-id",
      targetAuthorUuid: "uuid:123e4567-e89b-12d3-a456-426614174000",
    });

    const params = requireRpcParams();
    expect(params.recipients).toBeUndefined();
    expect(params.groupIds).toEqual(["group-id"]);
    expect(params.targetAuthor).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("records note-to-self reaction echoes for self recipients", async () => {
    resolvedSignalAccountConfig.current = {
      account: "+15550001111",
      accountUuid: "123e4567-e89b-12d3-a456-426614174000",
      ingressMode: "note-to-self",
    };

    await sendReactionSignal("+15550001111", 456, "👍", {
      cfg: SIGNAL_TEST_CFG,
    });

    expect(rememberSignalSelfReplyEchoMock).toHaveBeenCalledWith({
      accountId: "default",
      accountIdentity: "123e4567-e89b-12d3-a456-426614174000",
      messageId: "123",
      timestamp: 123,
      text: "<reaction:add:456:👍:+15550001111:>",
      includeTextWithPrimary: true,
    });
  });

  it("records note-to-self reaction echoes under the discovered account UUID", async () => {
    resolvedSignalAccountConfig.current = {
      account: "+15550001111",
      ingressMode: "note-to-self",
      configPath: "/tmp/signal-cli",
    };
    discoverSignalAccountUuidMock.mockResolvedValueOnce("123e4567-e89b-12d3-a456-426614174000");

    await sendReactionSignal("+15550001111", 456, "👍", {
      cfg: SIGNAL_TEST_CFG,
      targetAuthor: "+15550001111",
    });

    expect(discoverSignalAccountUuidMock).toHaveBeenCalledWith({
      account: "+15550001111",
      configPath: "/tmp/signal-cli",
    });
    expect(rememberSignalSelfReplyEchoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIdentity: "123e4567-e89b-12d3-a456-426614174000",
        text: "<reaction:add:456:👍:+15550001111:>",
      }),
    );
    expect(rememberSignalSelfReplyEchoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIdentity: "+15550001111",
        text: "<reaction:add:456:👍:+15550001111:>",
      }),
    );
  });

  it("keeps provisional note-to-self reaction echoes when response loss is ambiguous", async () => {
    resolvedSignalAccountConfig.current = {
      account: "+15550001111",
      accountUuid: "123e4567-e89b-12d3-a456-426614174000",
      ingressMode: "note-to-self",
    };
    rpcMock.mockRejectedValueOnce(new Error("Signal response timeout"));

    await expect(
      sendReactionSignal("+15550001111", 456, "👍", {
        cfg: SIGNAL_TEST_CFG,
        targetAuthor: "+15550001111",
      }),
    ).rejects.toThrow("Signal response timeout");

    expect(rememberSignalSelfReplyEchoMock).toHaveBeenCalledWith({
      accountId: "default",
      accountIdentity: "123e4567-e89b-12d3-a456-426614174000",
      messageId: "unknown",
      text: "<reaction:add:456:👍:+15550001111:>",
      includeTextWithPrimary: true,
    });
    expect(forgetSignalSelfReplyEchoMock).not.toHaveBeenCalled();
  });

  it("defaults targetAuthor to recipient for removals", async () => {
    await removeReactionSignal("+15551230000", 456, "❌", { cfg: SIGNAL_TEST_CFG });

    const params = requireRpcParams();
    expect(params.recipients).toEqual(["+15551230000"]);
    expect(params.targetAuthor).toBe("+15551230000");
    expect(params.remove).toBe(true);
  });
});
