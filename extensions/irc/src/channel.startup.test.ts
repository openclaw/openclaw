import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartAccountContext } from "../../test-utils/start-account-context.js";
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

    const abort = new AbortController();
    const task = ircPlugin.gateway!.startAccount!(
      createStartAccountContext({
        account,
        abortSignal: abort.signal,
      }),
    );
    let settled = false;
    void task.then(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(hoisted.monitorIrcProvider).toHaveBeenCalledOnce();
    });
    expect(settled).toBe(false);
    expect(stop).not.toHaveBeenCalled();

    abort.abort();
    await task;

    expect(stop).toHaveBeenCalledOnce();
  });
});
