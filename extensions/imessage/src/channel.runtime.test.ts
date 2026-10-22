import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import { IMessageRpcClient } from "./client.js";
import { sendMessageIMessage } from "./send.js";

const monitorMock = vi.hoisted(() => vi.fn(async () => undefined));
const createRpcClientMock = vi.hoisted(() => vi.fn());

vi.mock("./monitor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor.js")>()),
  monitorIMessageProvider: monitorMock,
}));

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createIMessageRpcClient: createRpcClientMock,
}));

const { sendIMessageOutbound, startIMessageGatewayAccount } = await import("./channel.runtime.js");
const { resolveIMessageAccount } = await import("./accounts.js");
const { imessagePlugin } = await import("./channel.js");
type Config = Parameters<typeof resolveIMessageAccount>[0]["cfg"];
type ChannelConfig = NonNullable<NonNullable<Config["channels"]>["imessage"]>;
function accountConfig(
  accounts: ChannelConfig["accounts"],
  config: Omit<ChannelConfig, "accounts"> = {},
) {
  return { channels: { imessage: { ...config, accounts } } };
}
function skipsWatcher(logEvents: { line: string }[]) {
  return logEvents.some((event) => event.line.includes("skipping watcher"));
}

function makeCtx(cfg: Config, accountId: string) {
  const account = resolveIMessageAccount({ cfg, accountId });
  const ac = new AbortController();
  const statusEvents: unknown[] = [];
  const logEvents: { level: string; line: string }[] = [];
  return {
    ctx: {
      scheduler: createTestPluginServiceScheduler(),
      cfg,
      accountId,
      account,
      runtime: {} as never,
      abortSignal: ac.signal,
      log: {
        info: (line: string) => logEvents.push({ level: "info", line }),
      },
      getStatus: () => ({ accountId }),
      setStatus: (next: unknown) => statusEvents.push(next),
      channelRuntime: undefined as never,
    } as never,
    abort: () => ac.abort(),
    statusEvents,
    logEvents,
  };
}

describe("startIMessageGatewayAccount duplicate-source handling", () => {
  it.each([
    ["swang430-gmail-com", "default", false],
    ["primary", "secondary", true],
  ] as const)(
    "parks duplicate %s / %s (owner started: %s)",
    async (ownerId, duplicateId, startOwner) => {
      monitorMock.mockReset().mockResolvedValue(undefined);
      const cfg = accountConfig({
        [ownerId]: { cliPath: startOwner ? "/usr/local/bin/imsg" : "imsg" },
        [duplicateId]: startOwner
          ? {
              cliPath: "/usr/local/bin/imsg",
              dbPath: path.join(process.env.HOME || os.homedir(), "Library", "Messages", "chat.db"),
            }
          : { enabled: true },
      });
      if (startOwner) {
        await startIMessageGatewayAccount(makeCtx(cfg, ownerId).ctx);
      }
      const { ctx, abort, logEvents, statusEvents } = makeCtx(cfg, duplicateId);
      const settled = vi.fn();
      const task = startIMessageGatewayAccount(ctx).then(settled);
      const monitorCount = startOwner ? 1 : 0;
      try {
        await vi.waitFor(() => expect(skipsWatcher(logEvents)).toBe(true));
        expect(monitorMock).toHaveBeenCalledTimes(monitorCount);
        expect(settled).not.toHaveBeenCalled();
        expect(logEvents.some((e) => e.line.includes(`using account "${ownerId}"`))).toBe(true);
        expect(statusEvents).not.toEqual([]);
        expect(statusEvents.every((event) => !(event as Record<string, unknown>).lifecycle)).toBe(
          true,
        );
      } finally {
        abort();
        await task;
      }
      expect(settled).toHaveBeenCalled();
      expect(monitorMock).toHaveBeenCalledTimes(monitorCount);
    },
  );

  it("starts independent monitors for distinct auto-detected remote wrappers named imsg", async () => {
    monitorMock.mockClear();
    monitorMock.mockResolvedValue(undefined);
    const remoteAccount = (host: string) => ({
      enabled: true,
      cliPath: `/opt/${host}/imsg`,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    });
    const cfg = accountConfig({
      primary: remoteAccount("host-a"),
      secondary: remoteAccount("host-b"),
    });
    const first = makeCtx(cfg, "primary");
    const second = makeCtx(cfg, "secondary");

    await startIMessageGatewayAccount(first.ctx);
    await startIMessageGatewayAccount(second.ctx);
    expect(monitorMock).toHaveBeenCalledTimes(2);
    expect(skipsWatcher(second.logEvents)).toBe(false);
  });
});

it("keeps a Gateway-shaped host media capability reader-free", async () => {
  const mediaAccess = { localRoots: ["/trusted/workspace"], workspaceDir: "/trusted/workspace" };
  const send = vi.fn(
    async (_to: string, _text: string, options: { mediaAccess?: typeof mediaAccess }) => ({
      messageId: "p:0/gateway-media",
      options,
    }),
  );

  await sendIMessageOutbound({
    cfg: {} as never,
    to: "+15551230000",
    text: "caption",
    mediaUrl: "workspace-image.png",
    mediaAccess,
    deps: { imessage: send },
  });

  expect(send.mock.calls[0]?.[2]?.mediaAccess).toBe(mediaAccess);
  expect(send.mock.calls[0]?.[2]).not.toHaveProperty("mediaReadFile");
});

it("enforces the resolved account cap for work", async () => {
  const state = await createOpenClawTestState({ prefix: "imessage-account-media-" });
  const client = new IMessageRpcClient();
  const delivered: Buffer[] = [];
  const request = vi.spyOn(client, "request").mockImplementation(async (_method, params) => {
    if (typeof params?.file !== "string") {
      throw new Error("Missing native attachment path");
    }
    delivered.push(await readFile(params.file));
    return { guid: "p:0/account-media" };
  });
  try {
    const smallBytes = Buffer.from("%PDF-1.4\nsmall attachment");
    const largeBytes = Buffer.alloc(2 * 1024 * 1024, 0x61);
    const small = state.path("small.pdf");
    const large = state.path("large.pdf");
    await writeFile(small, smallBytes);
    await writeFile(large, largeBytes);
    const send: typeof sendMessageIMessage = (to, text, options) =>
      sendMessageIMessage(to, text, { ...options, client });
    const params = {
      cfg: accountConfig(
        { Work: { mediaMaxMb: 1 } },
        {
          cliPath: state.path("fixture-imsg"),
          dbPath: state.path("fixture-chat.db"),
          mediaMaxMb: 8,
          defaultAccount: "work",
        },
      ),
      accountId: "work",
      to: "imessage:+15555550123",
      text: "",
      mediaLocalRoots: [state.root],
      deps: { imessage: send },
    };
    await expect(sendIMessageOutbound({ ...params, mediaUrl: large })).rejects.toThrow(
      /exceeds.*limit/i,
    );
    expect(request).not.toHaveBeenCalled();
    const result = await sendIMessageOutbound({ ...params, mediaUrl: small });
    expect(result.receipt.platformMessageIds).toEqual(["p:0/account-media"]);
    expect(delivered).toEqual([smallBytes]);
    await sendIMessageOutbound({ ...params, accountId: "default", mediaUrl: large });
    expect(delivered).toEqual([smallBytes, largeBytes]);
  } finally {
    request.mockRestore();
    await client.stop();
    await state.cleanup();
  }
});

const pairingCfg = accountConfig(
  {
    alpha: { cliPath: "/gateway/alpha-imsg", dbPath: "/gateway/alpha-chat.db" },
    beta: { cliPath: "/gateway/beta-imsg", dbPath: "/gateway/beta-chat.db" },
  },
  { defaultAccount: "alpha" },
);

it("sends the approval from the approved account", async () => {
  const notifyApproval = imessagePlugin.pairing?.notifyApproval;
  if (!notifyApproval) {
    throw new Error("imessage pairing.notifyApproval unavailable");
  }
  const request = vi.fn(async () => ({ guid: "p:0/pairing-approval" }));
  createRpcClientMock.mockReset();
  createRpcClientMock.mockResolvedValue({ request, stop: vi.fn(async () => {}) });

  await notifyApproval({ cfg: pairingCfg, id: "+15551234567", accountId: "beta" });

  expect(createRpcClientMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ cliPath: "/gateway/beta-imsg", dbPath: "/gateway/beta-chat.db" }),
  );
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "send",
    expect.objectContaining({
      to: "+15551234567",
      text: "✅ OpenClaw access approved. Send a message to start chatting.",
    }),
    expect.any(Object),
  );
});
