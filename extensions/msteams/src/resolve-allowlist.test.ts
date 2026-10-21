import { beforeEach, expect, it, vi } from "vitest";
import type { MSTeamsTeamConfig } from "../runtime-api.js";

const {
  listTeamsByNameWithPageInfo,
  listChannelsForTeamWithPageInfo,
  resolveGraphToken,
  findGraphUsersByExactIdentity,
} = vi.hoisted(() => ({
  listTeamsByNameWithPageInfo: vi.fn(),
  listChannelsForTeamWithPageInfo: vi.fn(),
  resolveGraphToken: vi.fn(async () => "graph-token"),
  findGraphUsersByExactIdentity: vi.fn(),
}));

vi.mock("./graph.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./graph.js")>()),
  listTeamsByNameWithPageInfo,
  listChannelsForTeamWithPageInfo,
  resolveGraphToken,
}));

vi.mock("./graph-users.js", () => ({
  findGraphUsersByExactIdentity,
}));

import {
  looksLikeMSTeamsTargetId,
  projectStableMSTeamsGroupAllowlist,
  projectStableMSTeamsUserAllowlist,
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsTeamsConfig,
  resolveMSTeamsUserAllowlist,
} from "./resolve-allowlist.js";

const alice = { id: "user-1", displayName: "Alice" };
const userId = "40a1a0ed-4ff2-4164-a219-55518990c197";

function page<T>(items: T[], truncated = false) {
  return { items, truncated };
}

function team(channelEntries: MSTeamsTeamConfig["channels"]) {
  return { channels: channelEntries };
}

function users(entries: string[]) {
  return resolveMSTeamsUserAllowlist({ cfg: {}, entries });
}

function channels(
  entries: string[],
  options: Partial<Parameters<typeof resolveMSTeamsChannelAllowlist>[0]> = {},
) {
  return resolveMSTeamsChannelAllowlist({ cfg: {}, entries, ...options });
}

beforeEach(() => {
  listTeamsByNameWithPageInfo.mockReset();
  listChannelsForTeamWithPageInfo.mockReset();
  resolveGraphToken.mockReset().mockResolvedValue("graph-token");
  findGraphUsersByExactIdentity.mockReset();
});

it("marks empty input unresolved", async () => {
  const [result] = await users(["  "]);
  expect(result).toEqual({ input: "  ", resolved: false });
});

it("uses the selected named account for Graph user lookup credentials", async () => {
  const cfg = { channels: { msteams: { defaultAccount: "default" } } };
  findGraphUsersByExactIdentity.mockResolvedValueOnce(page([alice]));

  await resolveMSTeamsUserAllowlist({ cfg, accountId: "support", entries: ["Alice"] });

  expect(resolveGraphToken).toHaveBeenCalledWith(cfg, { accountId: "support" });
});

it("keeps the first exact identity match when Graph repeats a user ID", async () => {
  findGraphUsersByExactIdentity.mockResolvedValueOnce(
    page([
      { id: "user-1", displayName: "Another user" },
      { id: " user-1 ", displayName: "Alice" },
      { id: "user-1", displayName: "ALICE" },
      { id: " ", displayName: "Alice" },
    ]),
  );

  await expect(users(["Alice"])).resolves.toEqual([
    { input: "Alice", resolved: true, id: " user-1 ", name: "Alice" },
  ]);
});

it.each([
  [page([alice, { id: "user-2", mail: "alice" }]), "user identity is ambiguous"],
  [page([alice], true), "user lookup incomplete"],
] as const)("rejects Graph users: %s / %s", async (resultPage, note) => {
  findGraphUsersByExactIdentity.mockResolvedValueOnce(resultPage);
  await expect(users(["Alice"])).resolves.toEqual([{ input: "Alice", resolved: false, note }]);
});

it("keeps stable user IDs without acquiring a Graph token", async () => {
  await expect(users([`user:${userId}`])).resolves.toEqual([
    {
      input: `user:${userId}`,
      resolved: true,
      id: userId,
    },
  ]);
  expect(resolveGraphToken).not.toHaveBeenCalled();
});

it("keeps stable IDs, wildcards, and access groups while dropping mutable identities", () => {
  expect(
    projectStableMSTeamsUserAllowlist([
      "*",
      "accessGroup:operators",
      `msteams:user:${userId}`,
      "Alice Example",
    ]),
  ).toEqual(["*", "accessGroup:operators", userId]);
});

it("does not authorize group conversation IDs in the direct-message allowlist", () => {
  expect(
    projectStableMSTeamsUserAllowlist([
      "19:group@thread.tacv2",
      "19:legacy@thread.skype",
      `user:${userId}`,
    ]),
  ).toEqual([userId]);
});

it("keeps normalized group conversation IDs alongside stable sender entries", () => {
  const entries = {
    "19:group@thread.tacv2;messageid=1740123456789": "19:group@thread.tacv2",
    "19:GROUP@THREAD.TACV2": "19:GROUP@THREAD.TACV2",
    "19:modern-group@thread.v2;messageid=1740123456789": "19:modern-group@thread.v2",
    "msteams:conversation:19:legacy@thread.skype": "19:legacy@thread.skype",
    "accessGroup:operators": "accessGroup:operators",
    [`msteams:user:${userId}`]: userId,
    "Mutable Display Name": null,
    "a:personal-chat": null,
    "19:personal@unq.gbl.spaces": null,
  };
  expect(projectStableMSTeamsGroupAllowlist(Object.keys(entries))).toEqual(
    Object.values(entries).filter((value) => value !== null),
  );
});

it("normalizes conversation-prefixed configured channel IDs", async () => {
  const [result] = await channels([
    "19:team-general@thread.tacv2/conversation:19:roadmap@thread.tacv2",
  ]);

  expect(result).toEqual({
    input: "19:team-general@thread.tacv2/conversation:19:roadmap@thread.tacv2",
    resolved: true,
    teamId: "19:team-general@thread.tacv2",
    teamName: "19:team-general@thread.tacv2",
    channelId: "19:roadmap@thread.tacv2",
    channelName: "19:roadmap@thread.tacv2",
  });
  expect(resolveGraphToken).not.toHaveBeenCalled();
});

it.each(["general", "lookup-failure", "missing-general", "graph"] as const)(
  "resolves team-only entries: %s",
  async (mode) => {
    listTeamsByNameWithPageInfo.mockResolvedValueOnce(
      page([{ id: "guid-ops", displayName: "Operations" }]),
    );
    if (mode === "lookup-failure") {
      listChannelsForTeamWithPageInfo.mockRejectedValueOnce(new Error("429 Too Many Requests"));
    } else if (mode !== "graph") {
      listChannelsForTeamWithPageInfo.mockResolvedValueOnce(
        page([
          {
            id: "19:ops-first@thread.tacv2",
            displayName: mode === "general" ? "General" : "Announcements",
          },
          { id: "19:ops-other@thread.tacv2", displayName: "Other" },
        ]),
      );
    }
    const [result] = await channels(["Operations"], {
      teamIdMode: mode === "graph" ? "graph" : "bot-framework",
    });
    if (mode === "lookup-failure") {
      expect(result).toEqual({
        input: "Operations",
        resolved: false,
        note: "channel lookup failed",
      });
    } else if (mode === "missing-general") {
      expect(result).toEqual({
        input: "Operations",
        resolved: false,
        graphTeamId: "guid-ops",
        teamName: "Operations",
        note: "General channel not found",
      });
    } else {
      expect(result).toEqual({
        input: "Operations",
        resolved: true,
        graphTeamId: "guid-ops",
        teamName: "Operations",
        teamId: mode === "graph" ? "guid-ops" : "19:ops-first@thread.tacv2",
      });
    }
    if (mode === "graph") {
      expect(listChannelsForTeamWithPageInfo).not.toHaveBeenCalled();
    }
  },
);

it("rejects partial, ambiguous, and incomplete team or channel matches", async () => {
  for (const [index, names] of [
    ["Product Team Extended"],
    ["Product Team", "product team"],
    ["Product Team"],
    ["Product Team"],
  ].entries()) {
    listTeamsByNameWithPageInfo.mockResolvedValueOnce(
      page(
        names.map((displayName, teamIndex) => ({ id: `team-${teamIndex + 1}`, displayName })),
        index === 2,
      ),
    );
  }
  listChannelsForTeamWithPageInfo.mockResolvedValueOnce(
    page([
      { id: "general", displayName: "General" },
      { id: "channel-1", displayName: "Roadmap" },
      { id: "channel-2", displayName: "roadmap" },
    ]),
  );

  const results = await channels([
    "Product Team",
    "Product Team",
    "Product Team",
    "Product Team/Roadmap",
  ]);

  expect(results.map((result) => result.note)).toEqual([
    "team not found",
    "team name is ambiguous",
    "team lookup incomplete",
    "channel name is ambiguous",
  ]);
  expect(results.every((result) => !result.resolved)).toBe(true);
});

it("builds a Graph-keyed projection for action routing", async () => {
  listTeamsByNameWithPageInfo.mockResolvedValueOnce(
    page([{ id: "11111111-1111-1111-1111-111111111111", displayName: "Product Team" }]),
  );
  listChannelsForTeamWithPageInfo.mockResolvedValueOnce(
    page([
      { id: "19:general@thread.tacv2", displayName: "General" },
      { id: "19:roadmap@thread.tacv2", displayName: "Roadmap" },
    ]),
  );

  const result = await resolveMSTeamsTeamsConfig({
    cfg: {},
    teamIdMode: "graph",
    teams: {
      "Product Team": team({ Roadmap: { requireMention: true } }),
    },
  });

  expect(result.mapping).toEqual([
    "Product Team/Roadmap→11111111-1111-1111-1111-111111111111/19:roadmap@thread.tacv2",
  ]);
  expect(result.teams["11111111-1111-1111-1111-111111111111"]).toMatchObject(
    team({ "19:roadmap@thread.tacv2": { requireMention: true } }),
  );
});

it("drops unresolved mutable keys while retaining wildcard and stable policy", async () => {
  listTeamsByNameWithPageInfo.mockResolvedValueOnce(page([]));

  const result = await resolveMSTeamsTeamsConfig({
    cfg: {},
    teamIdMode: "bot-framework",
    teams: {
      "*": team({
        "*": { requireMention: true },
        Mutable: { requireMention: false },
        "19:stable@thread.tacv2": { requireMention: false },
      }),
      Missing: team({ Roadmap: { requireMention: false } }),
    },
  });

  expect(result.teams).toEqual({
    "*": team({
      "*": { requireMention: true },
      "19:stable@thread.tacv2": { requireMention: false },
    }),
  });
  expect(result.unresolved).toEqual(["*/Mutable", "Missing/Roadmap"]);
});

it.each(["8:orgid:user-object-id"])("accepts explicit target %s", (raw) => {
  expect(looksLikeMSTeamsTargetId(raw)).toBe(true);
});

it.each(["user:John Smith", "Product Team/Roadmap"])("rejects non-id input %s", (raw) => {
  expect(looksLikeMSTeamsTargetId(raw)).toBe(false);
});
