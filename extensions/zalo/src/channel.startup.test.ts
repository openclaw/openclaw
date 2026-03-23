import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/zalo";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartAccountContext } from "../../test-utils/start-account-context.js";
import type { ResolvedZaloAccount } from "./accounts.js";

const hoisted = vi.hoisted(() => ({
  monitorZaloProvider: vi.fn(),
  probeZalo: vi.fn(async () => ({
    ok: false as const,
    error: "probe failed",
    elapsedMs: 1,
  })),
}));

vi.mock("./monitor.js", async () => {
  const actual = await vi.importActual<typeof import("./monitor.js")>("./monitor.js");
  return {
    ...actual,
    monitorZaloProvider: hoisted.monitorZaloProvider,
  };
});

vi.mock("./probe.js", async () => {
  const actual = await vi.importActual<typeof import("./probe.js")>("./probe.js");
  return {
    ...actual,
    probeZalo: hoisted.probeZalo,
  };
});

import { zaloPlugin } from "./channel.js";

function buildAccount(): ResolvedZaloAccount {
  return {
    accountId: "default",
    enabled: true,
    token: "test-token",
    tokenSource: "config",
    config: {},
  };
}

describe("zaloPlugin gateway.startAccount", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps startAccount pending until abort", async () => {
    hoisted.monitorZaloProvider.mockImplementationOnce(
      async ({ abortSignal }: { abortSignal: AbortSignal }) =>
        await new Promise<void>((resolve) => {
          if (abortSignal.aborted) {
            resolve();
            return;
          }
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );

    const patches: ChannelAccountSnapshot[] = [];
    const abort = new AbortController();
    const task = zaloPlugin.gateway!.startAccount!(
      createStartAccountContext({
        account: buildAccount(),
        abortSignal: abort.signal,
        statusPatchSink: (next) => patches.push({ ...next }),
      }),
    );

    let settled = false;
    void task.then(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(hoisted.probeZalo).toHaveBeenCalledOnce();
      expect(hoisted.monitorZaloProvider).toHaveBeenCalledOnce();
    });

    expect(settled).toBe(false);
    expect(patches).toContainEqual(
      expect.objectContaining({
        accountId: "default",
      }),
    );

    abort.abort();
    await task;

    expect(settled).toBe(true);
    expect(hoisted.monitorZaloProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "test-token",
        account: expect.objectContaining({ accountId: "default" }),
        abortSignal: abort.signal,
        useWebhook: false,
      }),
    );
  });
});
