import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../../src/plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../src/plugins/runtime.js";
import { createRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import type { PluginRuntime } from "../runtime-api.js";
import {
  deleteWebhookMock,
  getWebhookInfoMock,
  getUpdatesMock,
  getZaloRuntimeMock,
  loadLifecycleMonitorModule,
  resetLifecycleTestState,
  resolvePendingGetUpdates,
  setWebhookMock,
} from "../test-support/monitor-mocks-test-support.js";
import type { ResolvedZaloAccount } from "./accounts.js";

const TEST_ACCOUNT = {
  accountId: "default",
  config: {},
} as unknown as ResolvedZaloAccount;

let monitorZaloProvider: typeof import("./monitor.js").monitorZaloProvider;

async function startLifecycleMonitor(
  options: {
    useWebhook?: boolean;
    webhookSecret?: string;
    webhookUrl?: string;
  } = {},
) {
  const abort = new AbortController();
  const runtime = createRuntimeEnv();
  const run = monitorZaloProvider({
    token: "test-token",
    account: TEST_ACCOUNT,
    config: {},
    runtime,
    abortSignal: abort.signal,
    ...options,
  });
  return { abort, runtime, run };
}

describe("monitorZaloProvider lifecycle", () => {
  beforeEach(async () => {
    await resetLifecycleTestState();
    getZaloRuntimeMock.mockReturnValue({
      logging: {
        shouldLogVerbose: () => false,
      },
    } as Pick<PluginRuntime, "logging">);
    ({ monitorZaloProvider } = await loadLifecycleMonitorModule());
  });

  afterEach(async () => {
    resolvePendingGetUpdates();
    await resetLifecycleTestState();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("stays alive in polling mode until abort", async () => {
    let settled = false;
    const { abort, runtime, run } = await startLifecycleMonitor();
    const monitoredRun = run.then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(getUpdatesMock).toHaveBeenCalledTimes(1));

    expect(getWebhookInfoMock).toHaveBeenCalledTimes(1);
    expect(deleteWebhookMock).not.toHaveBeenCalled();
    expect(getUpdatesMock).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    abort.abort();
    resolvePendingGetUpdates();
    await monitoredRun;

    expect(settled).toBe(true);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Zalo provider stopped mode=polling"),
    );
  });

  it("deletes an existing webhook before polling", async () => {
    getWebhookInfoMock.mockResolvedValueOnce({
      ok: true,
      result: { url: "https://example.com/hooks/zalo" },
    });

    const { abort, runtime, run } = await startLifecycleMonitor();

    await vi.waitFor(() => expect(getUpdatesMock).toHaveBeenCalledTimes(1));

    expect(getWebhookInfoMock).toHaveBeenCalledTimes(1);
    expect(deleteWebhookMock).toHaveBeenCalledTimes(1);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Zalo polling mode ready (webhook disabled)"),
    );

    abort.abort();
    resolvePendingGetUpdates();
    await run;
  });

  it("continues polling when webhook inspection returns 404", async () => {
    const { ZaloApiError } = await import("./api.js");
    getWebhookInfoMock.mockRejectedValueOnce(new ZaloApiError("Not Found", 404, "Not Found"));

    const { abort, runtime, run } = await startLifecycleMonitor();

    await vi.waitFor(() => expect(getUpdatesMock).toHaveBeenCalledTimes(1));

    expect(getWebhookInfoMock).toHaveBeenCalledTimes(1);
    expect(deleteWebhookMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("webhook inspection unavailable; continuing without webhook cleanup"),
    );
    expect(runtime.error).not.toHaveBeenCalled();

    abort.abort();
    resolvePendingGetUpdates();
    await run;
  });

  it("waits for webhook deletion before finishing webhook shutdown", async () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);

    let resolveDeleteWebhook: (() => void) | undefined;
    deleteWebhookMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDeleteWebhook = () => resolve({ ok: true, result: { url: "" } });
        }),
    );

    let settled = false;
    const { abort, runtime, run } = await startLifecycleMonitor({
      useWebhook: true,
      webhookUrl: "https://example.com/hooks/zalo",
      webhookSecret: "supersecret", // pragma: allowlist secret
    });
    const monitoredRun = run.then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(setWebhookMock).toHaveBeenCalledTimes(1));
    expect(registry.httpRoutes).toHaveLength(1);

    abort.abort();

    await vi.waitFor(() => expect(deleteWebhookMock).toHaveBeenCalledTimes(1));
    expect(deleteWebhookMock).toHaveBeenCalledWith("test-token", undefined, 5000);
    expect(settled).toBe(false);
    expect(registry.httpRoutes).toHaveLength(1);

    resolveDeleteWebhook?.();
    await monitoredRun;

    expect(settled).toBe(true);
    expect(registry.httpRoutes).toHaveLength(0);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Zalo provider stopped mode=webhook"),
    );
  });
});
