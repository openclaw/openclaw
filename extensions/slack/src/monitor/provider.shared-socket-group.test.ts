// Slack tests cover the shared Socket Mode connection for multiple accounts
// installed on the same Slack app (same app token).
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
});
