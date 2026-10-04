import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { RuntimeEnv } from "../runtime-api.js";
import { startBotIdentityRecovery } from "./monitor.bot-identity.js";
import type { ResolvedFeishuAccount } from "./types.js";

const fetchBotIdentityForMonitorMock = vi.hoisted(() => vi.fn());
const setFeishuBotIdentityStateMock = vi.hoisted(() => vi.fn());

vi.mock("./monitor.startup.js", () => ({
  fetchBotIdentityForMonitor: fetchBotIdentityForMonitorMock,
}));

vi.mock("./monitor.state.js", () => ({
  setFeishuBotIdentityState: setFeishuBotIdentityStateMock,
}));

const account: ResolvedFeishuAccount = {
  accountId: "person-2",
  selectionSource: "explicit",
  enabled: true,
  configured: true,
  domain: "feishu",
  appId: "cli_person_2",
  appSecret: "fixture-secret",
  config: {
    domain: "feishu",
    connectionMode: "websocket",
    webhookPath: "/feishu/events",
    dmPolicy: "pairing",
    reactionNotifications: "own",
    groupPolicy: "allowlist",
    typingIndicator: true,
    resolveSenderNames: true,
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  fetchBotIdentityForMonitorMock.mockReset();
  setFeishuBotIdentityStateMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Feishu bot identity recovery", () => {
  it("bypasses cache and stops only after a provider-verified refresh", async () => {
    fetchBotIdentityForMonitorMock
      .mockResolvedValueOnce({ botOpenId: "ou_cached", source: "cache" })
      .mockResolvedValueOnce({
        botOpenId: "ou_provider",
        botName: "OpenClaw QA",
        source: "provider",
      });
    const runtime = createRuntimeSpies() satisfies RuntimeEnv;

    startBotIdentityRecovery({
      account,
      accountId: "person-2",
      runtime,
      currentSource: "cache",
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchBotIdentityForMonitorMock).toHaveBeenCalledTimes(1);
    expect(fetchBotIdentityForMonitorMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ allowCachedFallback: false }),
    );
    expect(runtime.log).not.toHaveBeenCalledWith(
      expect.stringContaining("recovered via background retry"),
    );
    expect(setFeishuBotIdentityStateMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchBotIdentityForMonitorMock).toHaveBeenCalledTimes(2);
    expect(runtime.log).toHaveBeenCalledWith(
      "feishu[person-2]: bot open_id recovered via background retry: ou_provider",
    );
    expect(setFeishuBotIdentityStateMock).toHaveBeenCalledTimes(1);
    expect(setFeishuBotIdentityStateMock).toHaveBeenLastCalledWith("person-2", "ou_provider");
  });
});

describe("Feishu bot identity retry failures", () => {
  it("reports a rejected background retry without leaking an unhandled rejection", async () => {
    fetchBotIdentityForMonitorMock.mockRejectedValueOnce(new Error("probe exploded"));
    const runtime = createRuntimeSpies() satisfies RuntimeEnv;
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      startBotIdentityRecovery({
        account,
        accountId: "person-2",
        runtime,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      const nextTurn = new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await vi.advanceTimersByTimeAsync(0);
      await nextTurn;

      expect(fetchBotIdentityForMonitorMock).toHaveBeenCalledTimes(1);
      expect(runtime.error).toHaveBeenCalledTimes(1);
      expect(runtime.error).toHaveBeenCalledWith(
        "feishu[person-2]: bot identity background retry failed unexpectedly: Error: probe exploded",
      );
      expect(setFeishuBotIdentityStateMock).not.toHaveBeenCalled();
      expect(unhandled).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("stops an aborted retry without probing or reporting an error", async () => {
    const runtime = createRuntimeSpies() satisfies RuntimeEnv;
    const controller = new AbortController();

    startBotIdentityRecovery({
      account,
      accountId: "person-2",
      runtime,
      abortSignal: controller.signal,
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchBotIdentityForMonitorMock).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(setFeishuBotIdentityStateMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
