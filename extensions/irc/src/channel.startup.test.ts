import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
} from "../../test-utils/start-account-lifecycle.js";
import type { ResolvedIrcAccount } from "./accounts.js";

const hoisted = vi.hoisted(() => ({
  monitorIrcProvider: vi.fn(),
}));

vi.mock("./monitor.js", async () => {
  const actual = await vi.importActual<typeof import("./monitor.js")>("./monitor.js");
  return {
    ...actual,
    monitorIrcProvider: hoisted.monitorIrcProvider,
  };
});

import { ircPlugin } from "./channel.js";

describe("ircPlugin gateway.startAccount", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps startAccount pending until abort, then stops the monitor", async () => {
    const stop = vi.fn();
    hoisted.monitorIrcProvider.mockResolvedValue({ stop });

    const account: ResolvedIrcAccount = {
      accountId: "default",
      enabled: true,
      name: "default",
      configured: true,
      host: "irc.example.com",
      port: 6697,
      tls: true,
      nick: "openclaw",
      username: "openclaw",
      realname: "OpenClaw",
      password: "",
      passwordSource: "none",
      config: {} as ResolvedIrcAccount["config"],
    };

    const { abort, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: ircPlugin.gateway!.startAccount!,
      account,
    });

    await expectStopPendingUntilAbort({
      waitForStarted: () =>
        vi.waitFor(() => {
          expect(hoisted.monitorIrcProvider).toHaveBeenCalledOnce();
        }),
      isSettled,
      abort,
      task,
      stop,
    });
  });
});
