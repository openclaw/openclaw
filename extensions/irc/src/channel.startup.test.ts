import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "../../../test/helpers/extensions/start-account-lifecycle.js";
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

function buildAccount(): ResolvedIrcAccount {
  return {
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
}

describe("ircPlugin gateway.startAccount", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps startAccount pending until abort, then stops the monitor", async () => {
    const stop = vi.fn();
    hoisted.monitorIrcProvider.mockResolvedValue({ stop });

    const { abort, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: ircPlugin.gateway!.startAccount!,
      account: buildAccount(),
    });

    await expectStopPendingUntilAbort({
      waitForStarted: waitForStartedMocks(hoisted.monitorIrcProvider),
      isSettled,
      abort,
      task,
      stop,
    });
  });
});
