import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFreshIMessageReplyCacheForTest } from "./test-support/runtime.js";

const attachmentActions: ("sendAttachment" | "upload-file")[] = ["sendAttachment", "upload-file"];
const monitor = vi.hoisted(() => vi.fn());
vi.mock("./monitor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor.js")>()),
  monitorIMessageProvider: monitor,
}));

describe("iMessage Automation account status", () => {
  let send: typeof import("./send.js").sendMessageIMessage;
  let Client: typeof import("./client.js").IMessageRpcClient;
  let RpcError: typeof import("./client.js").IMessageRpcRequestError;
  let workContext: ReturnType<typeof createStartAccountContext>;
  let personalContext: ReturnType<typeof createStartAccountContext>;
  let workController: AbortController;
  let workTask: Promise<unknown>;
  let controllers: AbortController[] = [];
  let schedulers: ReturnType<typeof createTestPluginServiceScheduler>[] = [];
  let tasks: Promise<unknown>[] = [];
  const cfg = {
    channels: {
      imessage: {
        accounts: {
          work: { cliPath: "/fixture/work-imsg", dbPath: "/fixture/work.db" },
          personal: { cliPath: "/fixture/personal-imsg", dbPath: "/fixture/personal.db" },
        },
      },
    },
  };

  beforeEach(async () => {
    controllers = [];
    schedulers = [];
    tasks = [];
    await loadFreshIMessageReplyCacheForTest();
    const { getIMessageRuntime, setIMessageRuntime } = await import("./runtime.js");
    const channel = createPluginRuntimeMock().channel;
    setIMessageRuntime({ ...getIMessageRuntime(), channel });
    ({ sendMessageIMessage: send } = await import("./send.js"));
    ({ IMessageRpcClient: Client, IMessageRpcRequestError: RpcError } =
      await import("./client.js"));
    const { resolveIMessageAccount } = await import("./accounts.js");
    const { imessagePlugin } = await import("./channel.js");
    const ready = Promise.withResolvers<void>();
    let started = 0;
    monitor.mockImplementation(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      if (++started === 2) {
        ready.resolve();
      }
      await new Promise<void>((resolve) => {
        if (abortSignal.aborted) {
          resolve();
        } else {
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        }
      });
    });
    workController = new AbortController();
    const personalController = new AbortController();
    controllers = [workController, personalController];
    const createContext = (accountId: string, controller: AbortController) => {
      const scheduler = createTestPluginServiceScheduler();
      schedulers.push(scheduler);
      return {
        ...createStartAccountContext({
          account: resolveIMessageAccount({ cfg, accountId }),
          cfg,
          abortSignal: controller.signal,
        }),
        scheduler,
        channelRuntime: channel,
      };
    };
    const work = createContext("work", workController);
    const personal = createContext("personal", personalController);
    workContext = work;
    personalContext = personal;
    const start = imessagePlugin.gateway?.startAccount;
    if (!start) {
      throw new Error("iMessage startup unavailable");
    }
    workTask = start(work);
    tasks = [workTask, start(personal)];
    await Promise.race([
      ready.promise,
      Promise.all(tasks).then(() => {
        throw new Error("iMessage accounts stopped before monitoring started");
      }),
    ]);
  });

  afterEach(async () => {
    schedulers.forEach((scheduler) => scheduler.beginClose());
    controllers.forEach((controller) => controller.abort());
    try {
      await Promise.all(tasks);
    } finally {
      try {
        await Promise.all(schedulers.map((scheduler) => scheduler.stop()));
      } finally {
        monitor.mockReset();
        vi.restoreAllMocks();
      }
    }
  });

  it.each([-1743, -1712])(
    "reports %i without changing delivery uncertainty or retrying",
    async (code) => {
      const client = new Client();
      const data = {
        disposition: "may_have_completed",
        retry_safe: false,
        transport: "applescript",
        detail: "Messages automation failed with AppleScript error " + code + ".",
      };
      const error = new RpcError(data.detail, -32603, data);
      const request = vi.spyOn(client, "request").mockRejectedValueOnce(error);
      const sending = () =>
        send("+15555550123", "hello", { config: cfg, accountId: "WORK", client });
      await expect(sending()).rejects.toBe(error);
      const warning = workContext.getStatus().lastError;
      expect(warning).toContain(
        code === -1712 ? "couldn't confirm" : "permission to control Messages",
      );
      expect(warning).toContain("before retrying to avoid duplicates");
      expect(personalContext.getStatus().lastError).toBeUndefined();
      expect(request).toHaveBeenCalledTimes(1);
      expect(error.data).toBe(data);

      request.mockResolvedValueOnce({});
      await expect(sending()).resolves.toMatchObject({ messageId: "unknown" });
      expect(workContext.getStatus().lastError).toBe(warning);
      request.mockResolvedValueOnce({ guid: "confirmed-personal" });
      await send("+15555550123", "hello", { config: cfg, accountId: "personal", client });
      expect(workContext.getStatus().lastError).toBe(warning);
      request.mockResolvedValueOnce({ ok: true });
      await expect(sending()).resolves.toMatchObject({ messageId: "ok" });
      expect(workContext.getStatus().lastError).toBeNull();

      workContext.setStatus({ accountId: "work", lastError: "unrelated monitor error" });
      request.mockResolvedValueOnce({ guid: "confirmed-work" });
      await sending();
      expect(workContext.getStatus().lastError).toBe("unrelated monitor error");
      workController.abort();
      await workTask;
      request.mockRejectedValueOnce(error);
      await expect(sending()).rejects.toBe(error);
      expect(workContext.getStatus().lastError).toBe("unrelated monitor error");
    },
  );

  it("records local attachment denial and clears only after confirmed attachment delivery", async () => {
    const error = new Error("Messages automation failed with AppleScript error -1743.");
    const runCliJson = vi.fn().mockRejectedValueOnce(error);
    const options = {
      config: cfg,
      accountId: "work",
      mediaUrl: "fixture.pdf",
      resolveAttachmentImpl: async () => ({
        path: "/fixture/document.pdf",
        contentType: "application/pdf",
      }),
      runCliJson,
    };
    await expect(send("chat_guid:fixture-chat", "", options)).rejects.toBe(error);
    const warning = workContext.getStatus().lastError;
    expect(warning).toContain("permission to control Messages");
    expect(runCliJson).toHaveBeenCalledTimes(1);
    runCliJson.mockResolvedValueOnce({});
    await expect(send("chat_guid:fixture-chat", "", options)).resolves.toMatchObject({
      messageId: "unknown",
    });
    expect(workContext.getStatus().lastError).toBe(warning);
    runCliJson.mockResolvedValueOnce({ success: true });
    await expect(send("chat_guid:fixture-chat", "", options)).resolves.toMatchObject({
      messageId: "ok",
    });
    expect(workContext.getStatus().lastError).toBeNull();
    expect(personalContext.getStatus().lastError).toBeUndefined();
  });

  it.each(attachmentActions)(
    "%s preserves real local and remote delivery evidence without retrying",
    async (action) => {
      const { imessageMessageActions } = await import("./actions.js");
      const handleAction = imessageMessageActions.handleAction;
      if (!handleAction) {
        throw new Error("iMessage action handler unavailable");
      }
      const processRuntime = await import("openclaw/plugin-sdk/process-runtime");
      const { setCachedIMessagePrivateApiStatus, invalidateCachedIMessagePrivateApiStatus } =
        await import("./private-api-status.js");
      const command = vi.spyOn(processRuntime, "runCommandWithTimeout");
      vi.spyOn(Client.prototype, "start").mockResolvedValue(undefined);
      vi.spyOn(Client.prototype, "stop").mockResolvedValue(undefined);
      const request = vi.spyOn(Client.prototype, "request");
      const params = {
        chatGuid: "iMessage;+;fixture-chat",
        filename: "fixture.txt",
        buffer: "YWJj",
      };
      const cliPath = cfg.channels.imessage.accounts.work.cliPath;
      setCachedIMessagePrivateApiStatus(cliPath, {
        available: true,
        v2Ready: true,
        selectors: {},
        rpcMethods: ["send.attachment"],
      });
      try {
        for (const remoteHost of [undefined, "messages-mac"]) {
          const actionCfg = {
            channels: {
              imessage: {
                accounts: {
                  ...cfg.channels.imessage.accounts,
                  work: { ...cfg.channels.imessage.accounts.work, remoteHost },
                },
              },
            },
          };
          const run = () =>
            handleAction({
              channel: "imessage",
              action,
              params,
              cfg: actionCfg,
              accountId: "WORK",
            });
          let response: Record<string, unknown> = {};
          let failure: Error | undefined;
          let dispatches = 0;
          // Fix only process/RPC I/O. The dispatcher, action producer, transport,
          // local JSON parser, remote staging and status completion stay real.
          command.mockImplementation(async (argv) => {
            if (argv[0] === cliPath) {
              dispatches++;
              if (failure) {
                throw failure;
              }
            } else if (argv[0] !== "ssh" && argv[0] !== "scp") {
              throw new Error("Unexpected command in action delivery fixture");
            }
            return {
              stdout: argv[0] === cliPath ? JSON.stringify(response) : "",
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
              termination: "exit",
            };
          });
          request.mockImplementation(async () => {
            dispatches++;
            if (failure) {
              throw failure;
            }
            return response;
          });
          const data = { disposition: "may_have_completed", retry_safe: false };
          const error = new RpcError(
            "Messages automation failed with AppleScript error -1712.",
            -32603,
            data,
          );
          failure = error;
          await expect(run()).rejects.toBe(error);
          expect(dispatches).toBe(1);
          expect(error.data).toBe(data);
          const warning = workContext.getStatus().lastError;
          expect(warning).toContain("before retrying to avoid duplicates");
          failure = undefined;
          const outcomes = [
            { raw: {}, expected: "unknown" },
            { raw: { ok: false }, expected: "unknown" },
            ...(remoteHost
              ? [{ raw: { success: false, error: "not confirmed" }, expected: "unknown" }]
              : []),
            { raw: { ok: true }, expected: "ok" },
            { raw: { success: true }, expected: "ok" },
            { raw: { status: "sent" }, expected: "ok" },
            { raw: { guid: "confirmed-action-guid" }, expected: "confirmed-action-guid" },
          ];
          for (const { raw, expected } of outcomes) {
            workContext.setStatus({ accountId: "work", lastError: warning });
            response = raw;
            const before = dispatches;
            await expect(run()).resolves.toMatchObject({ details: { messageId: expected } });
            expect(dispatches).toBe(before + 1);
            expect(workContext.getStatus().lastError).toBe(expected === "unknown" ? warning : null);
            expect(personalContext.getStatus().lastError).toBeUndefined();
          }
        }
      } finally {
        invalidateCachedIMessagePrivateApiStatus(cliPath);
      }
    },
  );
});
