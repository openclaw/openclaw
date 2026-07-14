// Feishu tests cover monitor.bot identity recovery behavior.
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBotIdentityRecoveryAfterProbe } from "./monitor.bot-identity.js";
import { botOpenIds, setFeishuBotIdentityState } from "./monitor.state.js";
import type { ResolvedFeishuAccount } from "./types.js";

const probeFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  probeFeishuMock.mockReset();
  botOpenIds.delete("default");
});

function buildAccount(): ResolvedFeishuAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    appId: "cli_test",
    appSecret: "secret_test", // pragma: allowlist secret
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
    },
  } as ResolvedFeishuAccount;
}

function startAbortedProbeRecovery(runtime: ReturnType<typeof createNonExitingRuntimeEnv>): void {
  const controller = new AbortController();
  controller.abort();
  startBotIdentityRecoveryAfterProbe({
    account: buildAccount(),
    accountId: "default",
    runtime,
    abortSignal: controller.signal,
  });
}

describe("startBotIdentityRecoveryAfterProbe", () => {
  it("does not let stale aborted-lifecycle recovery overwrite replacement bot identity", async () => {
    vi.useFakeTimers();
    const runtime = createNonExitingRuntimeEnv();
    setFeishuBotIdentityState("default", { botOpenId: "", botName: undefined });
    probeFeishuMock.mockResolvedValueOnce({ ok: true, botOpenId: "ou_stale", botName: "Stale" });

    startAbortedProbeRecovery(runtime);
    setFeishuBotIdentityState("default", { botOpenId: "ou_replacement", botName: "Replacement" });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(probeFeishuMock).toHaveBeenCalledTimes(1);
    expect(botOpenIds.get("default")).toBe("ou_replacement");
  });

  it("recovers bot identity when no replacement lifecycle changes the revision", async () => {
    vi.useFakeTimers();
    const runtime = createNonExitingRuntimeEnv();
    setFeishuBotIdentityState("default", { botOpenId: "", botName: undefined });
    probeFeishuMock.mockResolvedValueOnce({
      ok: true,
      botOpenId: "ou_recovered",
      botName: "Recovered",
    });

    startAbortedProbeRecovery(runtime);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(probeFeishuMock).toHaveBeenCalledTimes(1);
    expect(botOpenIds.get("default")).toBe("ou_recovered");
  });

  it("keeps retrying after its own unknown identity update", async () => {
    vi.useFakeTimers();
    const runtime = createNonExitingRuntimeEnv();
    setFeishuBotIdentityState("default", { botOpenId: "", botName: undefined });
    probeFeishuMock
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, botOpenId: "ou_recovered", botName: "Recovered" });

    startAbortedProbeRecovery(runtime);

    await vi.advanceTimersByTimeAsync(180_000);

    expect(probeFeishuMock).toHaveBeenCalledTimes(2);
    expect(botOpenIds.get("default")).toBe("ou_recovered");
  });
});
