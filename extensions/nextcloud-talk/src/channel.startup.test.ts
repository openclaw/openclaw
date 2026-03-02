import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartAccountContext } from "../../test-utils/start-account-context.js";
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
      createStartAccountContext({
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
      createStartAccountContext({
        account: buildAccount(),
        abortSignal: abort.signal,
      }),
    );

    expect(hoisted.monitorNextcloudTalkProvider).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });
});
