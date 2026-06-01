import { describe, expect, it, vi } from "vitest";

const monitorMock = vi.hoisted(() => vi.fn(async () => undefined));
const sendMock = vi.hoisted(() => ({
  sendMessageIMessage: vi.fn(async () => ({ messageId: "m1" })),
}));

vi.mock("./monitor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor.js")>()),
  monitorIMessageProvider: monitorMock,
}));
vi.mock("./send.js", () => ({
  sendMessageIMessage: sendMock.sendMessageIMessage,
}));

const { sendIMessageOutbound, startIMessageGatewayAccount } = await import("./channel.runtime.js");
const { resolveIMessageAccount } = await import("./accounts.js");

function makeCtx(params: {
  cfg: Parameters<typeof resolveIMessageAccount>[0]["cfg"];
  accountId: string;
}) {
  const account = resolveIMessageAccount({ cfg: params.cfg, accountId: params.accountId });
  const ac = new AbortController();
  const statusEvents: unknown[] = [];
  const logEvents: { level: string; line: string }[] = [];
  return {
    ctx: {
      cfg: params.cfg,
      accountId: params.accountId,
      account,
      runtime: {} as never,
      abortSignal: ac.signal,
      log: {
        info: (line: string) => logEvents.push({ level: "info", line }),
      },
      getStatus: () => ({ accountId: params.accountId }),
      setStatus: (next: unknown) => statusEvents.push(next),
      channelRuntime: undefined as never,
    } as never,
    abort: () => ac.abort(),
    statusEvents,
    logEvents,
  };
}

describe("startIMessageGatewayAccount duplicate-source handling", () => {
  it("parks the watcher slot without spawning monitorIMessageProvider for a non-owner duplicate", async () => {
    monitorMock.mockClear();
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            "swang430-gmail-com": { cliPath: "imsg" },
            default: {},
          },
        },
      },
    } as never;
    const { ctx, abort, logEvents } = makeCtx({ cfg, accountId: "default" });

    const settled = vi.fn();
    const task = startIMessageGatewayAccount(ctx).then(settled);

    await Promise.resolve();
    await Promise.resolve();
    expect(monitorMock).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(logEvents.some((e) => e.line.includes("skipping watcher"))).toBe(true);
    expect(logEvents.some((e) => e.line.includes('using account "swang430-gmail-com"'))).toBe(true);

    abort();
    await task;
    expect(settled).toHaveBeenCalled();
    expect(monitorMock).not.toHaveBeenCalled();
  });

  it("starts monitorIMessageProvider for the duplicate-source owner", async () => {
    monitorMock.mockClear();
    monitorMock.mockResolvedValueOnce(undefined);
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            "swang430-gmail-com": { cliPath: "imsg" },
            default: {},
          },
        },
      },
    } as never;
    const { ctx } = makeCtx({ cfg, accountId: "swang430-gmail-com" });

    await startIMessageGatewayAccount(ctx);
    expect(monitorMock).toHaveBeenCalledTimes(1);
  });

  it("starts monitorIMessageProvider when an account has no duplicate sibling", async () => {
    monitorMock.mockClear();
    monitorMock.mockResolvedValueOnce(undefined);
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            solo: { cliPath: "/usr/local/bin/imsg-solo" },
          },
        },
      },
    } as never;
    const { ctx } = makeCtx({ cfg, accountId: "solo" });

    await startIMessageGatewayAccount(ctx);
    expect(monitorMock).toHaveBeenCalledTimes(1);
  });
});

describe("sendIMessageOutbound", () => {
  it("forwards trusted requester sender context with reply sends", async () => {
    sendMock.sendMessageIMessage.mockClear();

    await sendIMessageOutbound({
      cfg: { channels: { imessage: {} } },
      to: "chat_id:42",
      text: "hello",
      replyToId: "reply-1",
      replyToIdSource: "implicit",
      replyRequesterSender: "+15551230000",
    });

    expect(sendMock.sendMessageIMessage).toHaveBeenCalledWith(
      "chat_id:42",
      "hello",
      expect.objectContaining({
        replyToId: "reply-1",
        replyToIdSource: "implicit",
        replyRequesterSender: "+15551230000",
      }),
    );
  });
});
