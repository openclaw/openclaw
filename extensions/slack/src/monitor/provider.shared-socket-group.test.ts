// Slack tests cover the shared Socket Mode connection for multiple accounts
// installed on the same Slack app (same app token).
import { getEventListeners } from "node:events";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  flush,
  getSlackClientForToken,
  getSlackHandlerOrThrow,
  getSlackTestState,
  resetSlackTestState,
} from "../monitor.test-helpers.js";

const { monitorSlackProvider } = await import("./provider.js");

const SHARED_APP_TOKEN = "xapp-1-A0SHARED-sharedsecrettoken";
const TEAM1_BOT_TOKEN = "bot-token-team1";
const TEAM2_BOT_TOKEN = "bot-token-team2";

function sharedGroupConfig(): OpenClawConfig {
  return {
    channels: {
      slack: {
        dm: { enabled: true, policy: "open", allowFrom: ["*"] },
        groupPolicy: "open",
        accounts: {
          team1: { botToken: TEAM1_BOT_TOKEN, appToken: SHARED_APP_TOKEN, mode: "socket" },
          team2: { botToken: TEAM2_BOT_TOKEN, appToken: SHARED_APP_TOKEN, mode: "socket" },
        },
      },
    },
  };
}

function makeDirectMessageEvent(params: { channel: string; ts: string; text: string }) {
  return {
    type: "message" as const,
    user: "U_SENDER",
    text: params.text,
    ts: params.ts,
    channel: params.channel,
    channel_type: "im" as const,
  };
}

/** Gives each team account its own healthy bot identity on its own client. */
function mockHealthyTeamAuth() {
  getSlackClientForToken(TEAM1_BOT_TOKEN).auth.test.mockResolvedValue({
    user_id: "U_BOT1",
    bot_id: "B_BOT1",
    team_id: "T1",
    api_app_id: "A0SHARED",
  });
  getSlackClientForToken(TEAM2_BOT_TOKEN).auth.test.mockResolvedValue({
    user_id: "U_BOT2",
    bot_id: "B_BOT2",
    team_id: "T2",
    api_app_id: "A0SHARED",
  });
}

/** Starts both team accounts back-to-back (no await between the two calls) so
 * team1's synchronous prefix — including reserving the shared-socket-group
 * registry slot — always runs before team2 observes it, making team1 the
 * deterministic owner regardless of scheduling. */
function startBothTeamAccounts(config: ReturnType<typeof sharedGroupConfig>) {
  const controller1 = new AbortController();
  const controller2 = new AbortController();
  const setStatus1 = vi.fn();
  const setStatus2 = vi.fn();
  const run1 = monitorSlackProvider({
    accountId: "team1",
    config,
    abortSignal: controller1.signal,
    setStatus: setStatus1,
  });
  const run2 = monitorSlackProvider({
    accountId: "team2",
    config,
    abortSignal: controller2.signal,
    setStatus: setStatus2,
  });
  return { controller1, controller2, setStatus1, setStatus2, run1, run2 };
}

async function stopBothTeamAccounts(harness: ReturnType<typeof startBothTeamAccounts>) {
  await flush();
  harness.controller1.abort();
  harness.controller2.abort();
  await Promise.all([harness.run1, harness.run2]);
}

beforeEach(() => {
  resetSlackTestState(sharedGroupConfig());
});

describe("monitorSlackProvider shared Socket Mode group", () => {
  it("shares one App for two accounts on the same app token and demuxes by team_id", async () => {
    const client1 = getSlackClientForToken(TEAM1_BOT_TOKEN);
    const client2 = getSlackClientForToken(TEAM2_BOT_TOKEN);
    client1.auth.test.mockResolvedValue({
      user_id: "U_BOT1",
      bot_id: "B_BOT1",
      team_id: "T1",
      api_app_id: "A0SHARED",
    });
    client2.auth.test.mockResolvedValue({
      user_id: "U_BOT2",
      bot_id: "B_BOT2",
      team_id: "T2",
      api_app_id: "A0SHARED",
    });

    const harness = startBothTeamAccounts(sharedGroupConfig());
    try {
      // Both accounts register their "message" listener on the SAME shared
      // Bolt App; getSlackHandlerOrThrow returns one composed function that
      // invokes every registered listener (mirroring real Bolt's fan-out to
      // every matching listener on an App).
      const handler = await getSlackHandlerOrThrow("message");
      // Give the second (non-owner) account's registration a few more ticks
      // to land before asserting both are present.
      await flush();
      await flush();

      // The event-registry demux below would also "pass" if two accounts
      // each opened their own App and both happened to register into this
      // mock's global handler registry — that wouldn't prove real sharing.
      // Assert only ONE physical socket was actually started: Bolt's
      // App.start() is only called by the group owner (team1); a
      // non-shared implementation would call it once per account (twice).
      expect(getSlackTestState().appStartMock).toHaveBeenCalledTimes(1);

      harness.setStatus1.mockClear();
      harness.setStatus2.mockClear();

      // An event carrying team1's team_id should be processed by team1's
      // handler only; team2's shouldDropMismatchedSlackEvent filter must
      // reject it since its own ctx.teamId ("T2") does not match.
      await handler({
        event: makeDirectMessageEvent({ channel: "C_T1", ts: "111.001", text: "hi from team1" }),
        body: { api_app_id: "A0SHARED", team_id: "T1" },
      });

      expect(harness.setStatus1).toHaveBeenCalled();
      expect(harness.setStatus2).not.toHaveBeenCalled();

      harness.setStatus1.mockClear();
      harness.setStatus2.mockClear();

      // The reverse: an event carrying team2's team_id is handled only by
      // team2; team1 drops it. This confirms Slack's "deliver to exactly one
      // connection" behavior is fully compensated for by sharing one App and
      // demuxing via team_id, instead of losing team2's traffic to a second,
      // never-selected socket.
      await handler({
        event: makeDirectMessageEvent({ channel: "C_T2", ts: "222.002", text: "hi from team2" }),
        body: { api_app_id: "A0SHARED", team_id: "T2" },
      });

      expect(harness.setStatus1).not.toHaveBeenCalled();
      expect(harness.setStatus2).toHaveBeenCalled();
    } finally {
      await stopBothTeamAccounts(harness);
    }
  });

  it("resolves each account's boot-time auth.test via its OWN bot token client, not the shared app's owner client", async () => {
    const client1 = getSlackClientForToken(TEAM1_BOT_TOKEN);
    const client2 = getSlackClientForToken(TEAM2_BOT_TOKEN);
    client1.auth.test.mockResolvedValue({
      user_id: "U_BOT1",
      bot_id: "B_BOT1",
      team_id: "T1",
      api_app_id: "A0SHARED",
    });
    client2.auth.test.mockResolvedValue({
      user_id: "U_BOT2",
      bot_id: "B_BOT2",
      team_id: "T2",
      api_app_id: "A0SHARED",
    });

    const harness = startBothTeamAccounts(sharedGroupConfig());
    try {
      // Wait for both accounts to finish booting (handler registration
      // happens after the boot-time auth.test() call resolves).
      await getSlackHandlerOrThrow("message");
      await flush();
      await flush();

      // If team2's boot path incorrectly used the shared App's default
      // client (bound to the owner/team1's bot token) instead of a client
      // built from its OWN bot token, client2.auth.test would never be
      // called at all — every identity lookup would silently resolve via
      // client1 instead, and team2 would boot up believing it is team1.
      expect(client1.auth.test).toHaveBeenCalledTimes(1);
      expect(client2.auth.test).toHaveBeenCalledTimes(1);
    } finally {
      await stopBothTeamAccounts(harness);
    }
  });

  it("stops processing a stopped member's events while the shared socket stays up for siblings", async () => {
    const client1 = getSlackClientForToken(TEAM1_BOT_TOKEN);
    const client2 = getSlackClientForToken(TEAM2_BOT_TOKEN);
    client1.auth.test.mockResolvedValue({
      user_id: "U_BOT1",
      bot_id: "B_BOT1",
      team_id: "T1",
      api_app_id: "A0SHARED",
    });
    client2.auth.test.mockResolvedValue({
      user_id: "U_BOT2",
      bot_id: "B_BOT2",
      team_id: "T2",
      api_app_id: "A0SHARED",
    });

    const harness = startBothTeamAccounts(sharedGroupConfig());
    try {
      const handler = await getSlackHandlerOrThrow("message");
      await flush();
      await flush();

      // Stop ONLY team2 (per-account stop) while team1 keeps the shared
      // socket alive. Bolt has no listener-removal API, so team2's handler
      // physically stays registered on the shared App — the abort-signal
      // gate in shouldDropMismatchedSlackEvent is what must keep the stopped
      // account from acting like a zombie and still replying in Slack.
      harness.controller2.abort();
      await harness.run2;

      harness.setStatus1.mockClear();
      harness.setStatus2.mockClear();

      await handler({
        event: makeDirectMessageEvent({ channel: "C_T2", ts: "333.003", text: "after stop" }),
        body: { api_app_id: "A0SHARED", team_id: "T2" },
      });
      expect(harness.setStatus2).not.toHaveBeenCalled();

      // The surviving sibling still processes its own workspace's traffic.
      await handler({
        event: makeDirectMessageEvent({ channel: "C_T1", ts: "444.004", text: "still alive" }),
        body: { api_app_id: "A0SHARED", team_id: "T1" },
      });
      expect(harness.setStatus1).toHaveBeenCalled();
    } finally {
      await stopBothTeamAccounts(harness);
    }
  });

  it("fails closed for a shared-group account whose boot auth.test could not resolve a teamId", async () => {
    const client1 = getSlackClientForToken(TEAM1_BOT_TOKEN);
    const client2 = getSlackClientForToken(TEAM2_BOT_TOKEN);
    client1.auth.test.mockResolvedValue({
      user_id: "U_BOT1",
      bot_id: "B_BOT1",
      team_id: "T1",
      api_app_id: "A0SHARED",
    });
    // team2's bot token is broken: no identity, hence no teamId to demux by.
    client2.auth.test.mockRejectedValue(new Error("invalid_auth"));

    const harness = startBothTeamAccounts(sharedGroupConfig());
    try {
      const handler = await getSlackHandlerOrThrow("message");
      await flush();
      await flush();

      harness.setStatus1.mockClear();
      harness.setStatus2.mockClear();

      // With teamId unresolved, team2's mismatch filter would previously
      // skip the team check entirely and process BOTH workspaces' events.
      // On a shared connection that is a cross-tenant leak, so the account
      // must drop everything instead — even its own workspace's traffic.
      await handler({
        event: makeDirectMessageEvent({ channel: "C_T2", ts: "555.005", text: "to broken team" }),
        body: { api_app_id: "A0SHARED", team_id: "T2" },
      });
      await handler({
        event: makeDirectMessageEvent({ channel: "C_T1", ts: "666.006", text: "to team1" }),
        body: { api_app_id: "A0SHARED", team_id: "T1" },
      });

      expect(harness.setStatus2).not.toHaveBeenCalled();
      // team1 (healthy) still handles its own events.
      expect(harness.setStatus1).toHaveBeenCalled();
    } finally {
      await stopBothTeamAccounts(harness);
    }
  });

  it("resolves the creator's monitor promise on its own abort while the socket keeps serving siblings", async () => {
    mockHealthyTeamAuth();

    const harness = startBothTeamAccounts(sharedGroupConfig());
    try {
      const handler = await getSlackHandlerOrThrow("message");
      await flush();
      await flush();

      // Stop ONLY the creator (team1). The connection now runs as a
      // group-owned task, so the creator's monitor promise must resolve
      // immediately (the gateway's per-account stop contract) instead of
      // lingering until the whole group winds down.
      harness.controller1.abort();
      await harness.run1;

      harness.setStatus1.mockClear();
      harness.setStatus2.mockClear();

      // The surviving sibling still processes its workspace's events on the
      // connection the (stopped) creator originally opened...
      await handler({
        event: makeDirectMessageEvent({ channel: "C_T2", ts: "777.007", text: "creator gone" }),
        body: { api_app_id: "A0SHARED", team_id: "T2" },
      });
      expect(harness.setStatus2).toHaveBeenCalled();

      // ...while the stopped creator's own workspace traffic is dropped.
      await handler({
        event: makeDirectMessageEvent({ channel: "C_T1", ts: "888.008", text: "to stopped" }),
        body: { api_app_id: "A0SHARED", team_id: "T1" },
      });
      expect(harness.setStatus1).not.toHaveBeenCalled();
    } finally {
      await stopBothTeamAccounts(harness);
    }
  });

  it("releases members and the registry slot when the creator throws after joining but before the connection task starts", async () => {
    // team1's boot-time auth.test fails AND its runtime.log throws: the warn
    // emitted for the auth failure happens after the group slot was joined
    // but before the connection task exists — exactly the window where a
    // leaked reservation would leave members waiting forever.
    getSlackClientForToken(TEAM1_BOT_TOKEN).auth.test.mockRejectedValue(new Error("nope"));
    getSlackClientForToken(TEAM2_BOT_TOKEN).auth.test.mockResolvedValue({
      user_id: "U_BOT2",
      bot_id: "B_BOT2",
      team_id: "T2",
      api_app_id: "A0SHARED",
    });

    const config = sharedGroupConfig();
    const controller1 = new AbortController();
    const controller2 = new AbortController();
    const run1 = monitorSlackProvider({
      accountId: "team1",
      config,
      abortSignal: controller1.signal,
      runtime: {
        log: () => {
          throw new Error("boom-after-join");
        },
        error: vi.fn(),
        exit: vi.fn() as never,
      },
    });
    const run2 = monitorSlackProvider({
      accountId: "team2",
      config,
      abortSignal: controller2.signal,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() as never },
    });

    // The creator's monitor rejects with the boot error...
    await expect(run1).rejects.toThrow("boom-after-join");
    // ...and the member resolves on its own WITHOUT anyone aborting it: the
    // creator's cleanup force-stopped the group, releasing the passive wait.
    // (A leaked registry reservation would hang this await until the test
    // times out.)
    await run2;

    // No connection was ever started by the failed round.
    expect(getSlackTestState().appStartMock).not.toHaveBeenCalled();

    // The registry slot must be free again: a fresh pair forms a NEW group
    // whose creator actually starts the socket. If the dead group's slot had
    // leaked, both fresh accounts would join it as members and no App would
    // ever start.
    mockHealthyTeamAuth();
    const fresh = startBothTeamAccounts(config);
    try {
      await getSlackHandlerOrThrow("message");
      await flush();
      await flush();
      expect(getSlackTestState().appStartMock).toHaveBeenCalledTimes(1);
    } finally {
      await stopBothTeamAccounts(fresh);
    }
  });

  it("leaves the group cleanly when the second account throws on the sharing log", async () => {
    mockHealthyTeamAuth();

    const config = sharedGroupConfig();
    const controller1 = new AbortController();
    const controller2 = new AbortController();
    const setStatus1 = vi.fn();
    const run1 = monitorSlackProvider({
      accountId: "team1",
      config,
      abortSignal: controller1.signal,
      setStatus: setStatus1,
    });
    // The second joiner is the account that emits the one-time
    // "sharing socket" info log — the last remaining statement between
    // joining the group and any handler registration. If runtime.log throws
    // there, the member must still leave the group instead of lingering as a
    // handler-less refcount entry that keeps the group alive forever.
    const run2 = monitorSlackProvider({
      accountId: "team2",
      config,
      abortSignal: controller2.signal,
      runtime: {
        log: (...args: unknown[]) => {
          if (typeof args[0] === "string" && args[0].includes("sharing socket")) {
            throw new Error("boom-sharing-log");
          }
        },
        error: vi.fn(),
        exit: vi.fn() as never,
      },
    });

    await expect(run2).rejects.toThrow("boom-sharing-log");

    // The surviving creator keeps serving its own workspace.
    const handler = await getSlackHandlerOrThrow("message");
    await flush();
    await flush();
    setStatus1.mockClear();
    await handler({
      event: makeDirectMessageEvent({ channel: "C_T1", ts: "999.009", text: "still fine" }),
      body: { api_app_id: "A0SHARED", team_id: "T1" },
    });
    expect(setStatus1).toHaveBeenCalled();

    // The failed member's refcount entry must be gone: stopping the creator
    // (now the only member) must fully dissolve the group so a fresh pair
    // creates a NEW group whose creator starts a second socket. A lingering
    // ghost member would keep the old group alive, making the fresh pair
    // join it as members and never start another App.
    controller1.abort();
    await run1;
    await flush();

    const fresh = startBothTeamAccounts(config);
    try {
      await getSlackHandlerOrThrow("message");
      await flush();
      await flush();
      expect(getSlackTestState().appStartMock).toHaveBeenCalledTimes(2);
    } finally {
      await stopBothTeamAccounts(fresh);
    }
  });

  it("propagates a fatal socket error to every sharing account and leaves no abort listeners behind", async () => {
    mockHealthyTeamAuth();
    // First socket start dies with a non-recoverable auth error: the
    // group-owned task records it and tears the group down.
    getSlackTestState().appStartMock.mockRejectedValue(new Error("invalid_auth"));

    const harness = startBothTeamAccounts(sharedGroupConfig());

    // Both accounts' monitor promises surface the fatal error (neither was
    // stopped on purpose), symmetric between creator and member.
    await expect(harness.run1).rejects.toThrow("invalid_auth");
    await expect(harness.run2).rejects.toThrow("invalid_auth");

    // The passive wait settled via the GROUP's stop signal, so the listener
    // each account had registered on its OWN abort signal must have been
    // removed on settle — a once-listener that never fires is never
    // auto-removed, so forgetting the removeEventListener would leak here.
    expect(getEventListeners(harness.controller1.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(harness.controller2.signal, "abort")).toHaveLength(0);
  });
});
