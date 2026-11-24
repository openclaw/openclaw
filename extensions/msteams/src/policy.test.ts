import { describe, expect, it } from "vitest";
import type { MSTeamsConfig } from "../runtime-api.js";
import {
  resolveMSTeamsGroupToolPolicy,
  resolveMSTeamsReplyPolicy,
  resolveMSTeamsRouteConfig,
} from "./policy.js";

function toolConfig(teams: MSTeamsConfig["teams"]) {
  return { channels: { msteams: { teams } } };
}

function toolPolicy(teams: MSTeamsConfig["teams"], groupSpace: string, groupId: string) {
  return resolveMSTeamsGroupToolPolicy({ cfg: toolConfig(teams), groupSpace, groupId });
}

describe("msteams policy", () => {
  describe("resolveMSTeamsRouteConfig", () => {
    it("returns undefined configs when teamId is missing", () => {
      const cfg: MSTeamsConfig = { teams: { team123: { requireMention: false } } };

      const res = resolveMSTeamsRouteConfig({
        cfg,
        teamId: undefined,
        conversationId: "chan",
      });
      expect(res).toMatchObject({
        teamConfig: undefined,
        channelConfig: undefined,
        allowlistConfigured: true,
        allowed: false,
      });
    });

    it("blocks team and channel name matches by default", () => {
      const res = resolveMSTeamsRouteConfig({
        cfg: { teams: { "My Team": { channels: { "General Chat": {} } } } },
        teamName: "My Team",
        channelName: "General Chat",
        conversationId: "ignored",
        allowNameMatching: false,
      });

      expect(res).toMatchObject({
        teamConfig: undefined,
        channelConfig: undefined,
        allowed: false,
      });
    });
  });

  const mention = { requireMention: true };
  const noMention = { requireMention: false };
  const dmGlobal = { ...noMention, replyStyle: "top-level" as const };
  it.each([
    ["DM", { isDirectMessage: true, globalConfig: dmGlobal }, false, "thread"],
    ["default", { globalConfig: {} }, true, "thread"],
    ["channel", { teamConfig: mention, channelConfig: noMention }, false, "top-level"],
    ["team", { teamConfig: noMention }, false, "top-level"],
  ] satisfies [
    string,
    Partial<Parameters<typeof resolveMSTeamsReplyPolicy>[0]>,
    boolean,
    string,
  ][])("reply policy: %s", (_name, overrides, requireMention, replyStyle) => {
    expect(
      resolveMSTeamsReplyPolicy({
        isDirectMessage: false,
        globalConfig: mention,
        ...overrides,
      }),
    ).toEqual({ requireMention, replyStyle });
  });

  describe("resolveMSTeamsGroupToolPolicy", () => {
    it("uses stable projected keys and never raw mutable names", () => {
      const cfg = {
        channels: {
          msteams: {
            dangerouslyAllowNameMatching: true,
            teams: {
              "Mutable Team": {
                channels: {
                  "Mutable Channel": { tools: { allow: ["exec"] } },
                },
              },
              "19:stable-team@thread.tacv2": {
                channels: {
                  "19:stable-channel@thread.tacv2": { tools: { allow: ["read"] } },
                },
              },
            },
          },
        },
      };

      expect(
        resolveMSTeamsGroupToolPolicy({
          cfg,
          groupId: "19:unknown@thread.tacv2",
          groupChannel: "Mutable Channel",
          groupSpace: "Mutable Team",
        }),
      ).toBeUndefined();
      expect(
        resolveMSTeamsGroupToolPolicy({
          cfg,
          groupId: "19:stable-channel@thread.tacv2",
          groupSpace: "19:stable-team@thread.tacv2",
        }),
      ).toEqual({ allow: ["read"] });
    });

    it.each([
      [
        "scans across teams when none matches",
        "missing-team",
        {
          first: { channels: { other: { tools: { deny: ["other"] } } } },
          second: { channels: { target: { tools: { allow: ["cross-team"] } } } },
        },
        { allow: ["cross-team"] },
      ],
      [
        "scans past a policy-less matched team",
        "unknown-team",
        {
          "*": {},
          actual: { channels: { target: { tools: { deny: ["shell"] } } } },
        },
        { deny: ["shell"] },
      ],
      [
        "does not scan past a matched channel",
        "mine",
        {
          mine: { channels: { target: {} } },
          other: { channels: { target: { tools: { deny: ["shell"] } } } },
        },
        undefined,
      ],
    ] satisfies [
      string,
      string,
      MSTeamsConfig["teams"],
      ReturnType<typeof resolveMSTeamsGroupToolPolicy>,
    ][])("%s", (_name, groupSpace, teams, expected) => {
      expect(toolPolicy(teams, groupSpace, "target")).toEqual(expected);
    });

    it("falls from a fieldless channel entry to its team policy", () => {
      expect(
        toolPolicy(
          {
            team: {
              tools: { deny: ["team"] },
              channels: { channel: {} },
            },
          },
          "team",
          "channel",
        ),
      ).toEqual({ deny: ["team"] });
    });

    it("keeps slash-bearing flat scope keys collision-free", () => {
      const cfg = toolConfig({
        "a/channel:b": { tools: { allow: ["slash-team"] } },
        a: { channels: { b: { tools: { allow: ["nested-channel"] } } } },
      });

      expect(resolveMSTeamsGroupToolPolicy({ cfg, groupSpace: "a/channel:b" })).toEqual({
        allow: ["slash-team"],
      });
      expect(resolveMSTeamsGroupToolPolicy({ cfg, groupSpace: "a", groupId: "b" })).toEqual({
        allow: ["nested-channel"],
      });
    });
  });
});
