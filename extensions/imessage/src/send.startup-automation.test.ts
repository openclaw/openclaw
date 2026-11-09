import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, expect, it, vi } from "vitest";
import { loadFreshIMessageReplyCacheForTest } from "./test-support/runtime.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("keeps an outbound Automation warning through real watch readiness until a same-account send succeeds", async () => {
  await loadFreshIMessageReplyCacheForTest({ reuseDatabase: true });
  vi.useFakeTimers();
  const { getIMessageRuntime, setIMessageRuntime } = await import("./runtime.js");
  const channel = createPluginRuntimeMock().channel;
  setIMessageRuntime({ ...getIMessageRuntime(), channel });
  const { IMessageRpcClient, IMessageRpcRequestError } = await import("./client.js");
  const probe = await import("./probe.js");
  const { resolveIMessageAccount } = await import("./accounts.js");
  const { imessagePlugin } = await import("./channel.js");
  const { sendMessageIMessage } = await import("./send.js");
  const cfg = {
    channels: {
      imessage: {
        accounts: {
          work: { remoteHost: "fixture-work-mac" },
          personal: { remoteHost: "fixture-personal-mac" },
        },
      },
    },
  };
  const subscribed = Promise.withResolvers<void>();
  const releaseSubscribe = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const error = new IMessageRpcRequestError(
    "Messages automation failed with AppleScript error -1712.",
    -32603,
    { disposition: "may_have_completed", retry_safe: false },
  );
  let sendError: Error | undefined = error;
  let sendResponse: Record<string, unknown> = {};
  let subscriptions = 0;
  let readyAccounts = 0;
  // Fix external probe/process/RPC I/O, not the monitor, subscribe sequence,
  // ready patch, account status sink, send classification, or status registry.
  vi.spyOn(probe, "probeIMessage").mockResolvedValue({ ok: true });
  vi.spyOn(IMessageRpcClient.prototype, "start").mockResolvedValue(undefined);
  vi.spyOn(IMessageRpcClient.prototype, "waitForClose").mockImplementation(() => closed.promise);
  vi.spyOn(IMessageRpcClient.prototype, "stop").mockImplementation(async () => closed.resolve());
  vi.spyOn(IMessageRpcClient.prototype, "request").mockImplementation(async (method) => {
    if (method === "watch.subscribe") {
      if (++subscriptions === 2) {
        subscribed.resolve();
      }
      await releaseSubscribe.promise;
      return { subscription: 1 };
    }
    if (method === "watch.unsubscribe") {
      return {};
    }
    if (method !== "send") {
      throw new Error(`Unexpected fixture RPC: ${method}`);
    }
    if (sendError) {
      throw sendError;
    }
    return sendResponse;
  });
  const workController = new AbortController();
  const personalController = new AbortController();
  const controllers = [workController, personalController];
  const createContext = (accountId: string, controller: AbortController) => ({
    ...createStartAccountContext({
      account: resolveIMessageAccount({ cfg, accountId }),
      cfg,
      abortSignal: controller.signal,
      statusPatchSink: (snapshot) => {
        if (snapshot.lifecycle === "ready" && ++readyAccounts === 2) {
          ready.resolve();
        }
      },
    }),
    scheduler: createTestPluginServiceScheduler(),
    channelRuntime: channel,
  });
  const workContext = createContext("work", workController);
  const personalContext = createContext("personal", personalController);
  const contexts = [workContext, personalContext];
  for (const ctx of contexts) {
    ctx.setStatus({
      accountId: ctx.accountId,
      lastError: "old connection error",
      terminalDisconnect: true,
    });
  }
  const start = imessagePlugin.gateway?.startAccount;
  if (!start) {
    throw new Error("iMessage startup unavailable");
  }
  const tasks = Promise.all(contexts.map((ctx) => start(ctx)));
  const stoppedEarly = tasks.then(() => {
    throw new Error("iMessage accounts stopped before readiness");
  });
  const client = new IMessageRpcClient();
  const send = (accountId: string) =>
    sendMessageIMessage("+15555550123", "hello", { config: cfg, accountId, client });
  try {
    await Promise.race([subscribed.promise, stoppedEarly]);
    await expect(send("WORK")).rejects.toBe(error);
    const warning = workContext.getStatus().lastError;
    expect(warning).toContain("before retrying to avoid duplicates");
    expect(workContext.getStatus().lifecycle).toBe("starting");
    releaseSubscribe.resolve();
    await Promise.race([ready.promise, stoppedEarly]);
    expect(workContext.getStatus()).toMatchObject({
      lifecycle: "ready",
      running: true,
      connected: true,
      lastError: warning,
    });
    expect(personalContext.getStatus().lastError).toBeNull();
    expect(contexts.every((ctx) => ctx.getStatus().terminalDisconnect === undefined)).toBe(true);
    sendError = undefined;
    await expect(send("work")).resolves.toMatchObject({ messageId: "unknown" });
    expect(workContext.getStatus().lastError).toBe(warning);
    sendResponse = { guid: "confirmed-fixture-guid" };
    await send("personal");
    expect(workContext.getStatus().lastError).toBe(warning);
    await send("work");
    expect(workContext.getStatus().lastError).toBeNull();
    controllers.forEach((controller) => controller.abort());
    await tasks;
    sendError = error;
    await expect(send("work")).rejects.toBe(error);
    expect(workContext.getStatus().lastError).toBeNull();
  } finally {
    releaseSubscribe.resolve();
    controllers.forEach((controller) => controller.abort());
    closed.resolve();
    try {
      await tasks;
    } finally {
      await Promise.all(contexts.map((ctx) => ctx.scheduler.stop()));
    }
  }
});
