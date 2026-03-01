import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeEnv } from "../../test-utils/runtime-env.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";

const hoisted = vi.hoisted(() => ({
  monitorNextcloudTalkProvider: vi.fn(),
}));

vi.mock("./monitor.js", async () => {
  const actual = await vi.importActual<typeof import("./monitor.js")>("./monitor.js");
  return {
    ...actual,
    monitorNextcloudTalkProvider: hoisted.monitorNextcloudTalkProvider,
  };
});

import { nextcloudTalkPlugin } from "./channel.js";

function createStartAccountCtx(params: {
  account: ResolvedNextcloudTalkAccount;
  abortSignal: AbortSignal;
}): ChannelGatewayContext<ResolvedNextcloudTalkAccount> {
  const snapshot: ChannelAccountSnapshot = {
    accountId: params.account.accountId,
    configured: true,
    enabled: true,
    running: false,
  };
  return {
    accountId: params.account.accountId,
    account: params.account,
    cfg: {} as OpenClawConfig,
    runtime: createRuntimeEnv(),
    abortSignal: params.abortSignal,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getStatus: () => snapshot,
    setStatus: (next) => {
      Object.assign(snapshot, next);
    },
  };
}

function buildAccount(): ResolvedNextcloudTalkAccount {
  return {
    accountId: "default",
    enabled: true,
    baseUrl: "https://nextcloud.example.com",
    secret: "secret",
    secretSource: "config",
    config: {
      baseUrl: "https://nextcloud.example.com",
      botSecret: "secret",
      webhookPath: "/nextcloud-talk-webhook",
      webhookPort: 8788,
    },
  };
}

describe("nextcloudTalkPlugin gateway.startAccount", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps startAccount pending until abort, then stops the monitor", async () => {
    const stop = vi.fn();
    hoisted.monitorNextcloudTalkProvider.mockResolvedValue({ stop });
    const abort = new AbortController();

    const task = nextcloudTalkPlugin.gateway!.startAccount!(
      createStartAccountCtx({
        account: buildAccount(),
        abortSignal: abort.signal,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    let settled = false;
    void task.then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(hoisted.monitorNextcloudTalkProvider).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();

    abort.abort();
    await task;

    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops immediately when startAccount receives an already-aborted signal", async () => {
    const stop = vi.fn();
    hoisted.monitorNextcloudTalkProvider.mockResolvedValue({ stop });
    const abort = new AbortController();
    abort.abort();

    await nextcloudTalkPlugin.gateway!.startAccount!(
      createStartAccountCtx({
        account: buildAccount(),
        abortSignal: abort.signal,
      }),
    );

    expect(hoisted.monitorNextcloudTalkProvider).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });
});
