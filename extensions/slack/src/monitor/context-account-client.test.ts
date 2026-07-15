import { describe, expect, it } from "vitest";
import {
  isSelfAuthoredSlackBotMessage,
  resolveIncomingSlackEventTeamId,
} from "./context-account-client.js";

describe("resolveIncomingSlackEventTeamId", () => {
  it("resolves the Events API envelope team_id", () => {
    expect(resolveIncomingSlackEventTeamId({ team_id: "T1" })).toBe("T1");
  });

  it("falls back to interaction body team.id", () => {
    expect(resolveIncomingSlackEventTeamId({ team: { id: "T2" } })).toBe("T2");
  });

  it("prefers view.app_installed_team_id over the actor's team for view payloads", () => {
    // Slack Connect: the actor's team (T_ACTOR) can differ from the workspace
    // the app is installed in (T_INSTALLED). Bolt resolves the installed
    // workspace from view.app_installed_team_id for view submissions/closures,
    // and the installed workspace is the account demux key.
    expect(
      resolveIncomingSlackEventTeamId({
        team: { id: "T_ACTOR" },
        user: { team_id: "T_ACTOR" },
        view: { app_installed_team_id: "T_INSTALLED", team_id: "T_ACTOR" },
      }),
    ).toBe("T_INSTALLED");
  });

  it("falls back to view.team_id, then user.team_id, then empty", () => {
    expect(resolveIncomingSlackEventTeamId({ view: { team_id: "T3" } })).toBe("T3");
    expect(resolveIncomingSlackEventTeamId({ user: { team_id: "T4" } })).toBe("T4");
    expect(resolveIncomingSlackEventTeamId({})).toBe("");
    expect(resolveIncomingSlackEventTeamId(undefined)).toBe("");
  });
});

describe("isSelfAuthoredSlackBotMessage", () => {
  it("matches by user id", () => {
    expect(
      isSelfAuthoredSlackBotMessage({
        message: { user: "U_BOT" },
        botUserId: "U_BOT",
        botId: "B1",
      }),
    ).toBe(true);
  });

  it("matches by bot_id when the payload carries no user (bot_message shape)", () => {
    expect(
      isSelfAuthoredSlackBotMessage({
        message: { bot_id: "B1" },
        botUserId: "U_BOT",
        botId: "B1",
      }),
    ).toBe(true);
  });

  it("does not match a different bot or an unresolved own identity", () => {
    expect(
      isSelfAuthoredSlackBotMessage({
        message: { bot_id: "B_OTHER" },
        botUserId: "U_BOT",
        botId: "B1",
      }),
    ).toBe(false);
    expect(
      isSelfAuthoredSlackBotMessage({
        message: { bot_id: "B1" },
        botUserId: undefined,
        botId: undefined,
      }),
    ).toBe(false);
  });
});
