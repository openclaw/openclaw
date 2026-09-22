import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPersonWorkSessions,
  listMemberWorkSessions,
  listWorkSessions,
} from "./work-sessions.js";

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({ dispatchGatewayMethod: vi.fn() }));

describe("report work sessions", () => {
  beforeEach(() => vi.mocked(dispatchGatewayMethod).mockReset());
  it("uses the authenticated request and projects only link metadata, excluding incognito", async () => {
    vi.mocked(dispatchGatewayMethod).mockResolvedValueOnce({
      ok: true,
      payload: {
        sessions: [
          {
            key: "agent:writer:work",
            kind: "direct",
            displayName: "Review routing",
            owner: { actor: { type: "human", label: "Alice" } },
            status: "running",
            lastMessagePreview: "Not report evidence",
          },
          { key: "agent:writer:private", kind: "direct", incognito: true },
        ],
        hasMore: true,
        nextOffset: 80,
      },
    });
    const result = await listWorkSessions(40);
    expect(dispatchGatewayMethod).toHaveBeenCalledWith("sessions.list", {
      limit: 40,
      offset: 40,
      sortBy: "activity",
      archived: false,
      excludeSubagents: true,
      excludeCron: true,
      excludeSystem: true,
      configuredAgentsOnly: true,
      includeGlobal: false,
      includeUnknown: false,
      includeDerivedTitles: true,
      includeLastMessage: false,
    });
    expect(result).toMatchObject({
      available: true,
      sessions: [
        { key: "agent:writer:work", owner: { actor: { label: "Alice" } }, status: "running" },
      ],
      nextOffset: 80,
    });
    expect(JSON.stringify(result)).not.toContain("Not report evidence");
    expect(JSON.stringify(result)).not.toContain("agent:writer:private");
  });

  it.each([{ ok: false }, { ok: true, payload: {} }])(
    "distinguishes failed discovery from an empty list (%j)",
    async (response) => {
      vi.mocked(dispatchGatewayMethod).mockResolvedValueOnce(response);
      expect(await listWorkSessions()).toEqual({ available: false });
    },
  );

  it("does not expose internal dispatch errors", async () => {
    vi.mocked(dispatchGatewayMethod).mockRejectedValueOnce(new Error("private transport detail"));
    expect(await listWorkSessions()).toEqual({ available: false });
  });
});

describe("per-member current work", () => {
  beforeEach(() => vi.mocked(dispatchGatewayMethod).mockReset());
  const profile = (id: string, login: string | null, mergedInto: string | null = null) => ({
    id,
    mergedInto,
    githubIdentity: login ? { login } : null,
  });
  const identities = (profiles: ReturnType<typeof profile>[]) => {
    vi.mocked(dispatchGatewayMethod).mockResolvedValueOnce({ ok: true, payload: { profiles } });
  };

  it("resolves aliases case-insensitively through merges and deduplicates owner pages per request", async () => {
    identities([profile("old", "Old-Alice", "alice"), profile("alice", "Alice")]);
    const sessions = vi.fn().mockResolvedValue({ available: true, sessions: [] });
    const list = createPersonWorkSessions(sessions);
    await Promise.all([list({ github: ["OLD-alice", "ALICE"] }), list({ github: ["Alice"] })]);
    expect(dispatchGatewayMethod).toHaveBeenCalledTimes(1);
    expect(sessions).toHaveBeenCalledExactlyOnceWith(0, 3, "alice");
    await list({ github: ["alice"] }, 40, 40);
    expect(sessions).toHaveBeenLastCalledWith(40, 40, "alice");
    identities([profile("new-owner", "Alice")]);
    await createPersonWorkSessions(sessions)({ github: ["alice"] });
    expect(sessions).toHaveBeenLastCalledWith(0, 3, "new-owner");
  });

  it.each([
    { profiles: [profile("name-only", null)], aliases: ["name-only"], reason: "unlinked" },
    {
      profiles: [profile("a", "Alice"), profile("b", "alias")],
      aliases: ["alice", "alias"],
      reason: "ambiguous",
    },
    { profiles: [profile("a", "Alice", "missing")], aliases: ["alice"], reason: "ambiguous" },
    {
      profiles: [profile("a", "Alice", "b"), profile("b", null, "a")],
      aliases: ["alice"],
      reason: "ambiguous",
    },
  ])(
    "never queries unfiltered sessions for $reason identity",
    async ({ profiles, aliases, reason }) => {
      identities(profiles);
      const sessions = vi.fn();
      expect(await createPersonWorkSessions(sessions)({ github: aliases })).toEqual({
        available: false,
        reason,
      });
      expect(sessions).not.toHaveBeenCalled();
    },
  );

  it("distinguishes unavailable identity dispatch from unlinked and empty owned sessions", async () => {
    vi.mocked(dispatchGatewayMethod).mockRejectedValueOnce(new Error("private detail"));
    const sessions = vi.fn();
    expect(await createPersonWorkSessions(sessions)({ github: ["alice"] })).toEqual({
      available: false,
    });
    expect(sessions).not.toHaveBeenCalled();
  });

  it("selects canonical ownership before server pagination, retaining privacy exclusions", async () => {
    identities([profile("alice", "Alice")]);
    vi.mocked(dispatchGatewayMethod).mockResolvedValueOnce({
      ok: true,
      payload: {
        sessions: [
          { key: "agent:writer:older-than-global-first-40", label: "Owned work" },
          { key: "agent:writer:private", incognito: true },
        ],
        hasMore: true,
        nextOffset: 80,
      },
    });
    const result = await createPersonWorkSessions(listWorkSessions)({ github: ["ALICE"] }, 40, 40);
    expect(dispatchGatewayMethod).toHaveBeenLastCalledWith(
      "sessions.list",
      expect.objectContaining({
        profileRelation: { profileId: "alice", relationship: "owned" },
        offset: 40,
        limit: 40,
        archived: false,
        excludeSubagents: true,
        excludeCron: true,
        excludeSystem: true,
        includeLastMessage: false,
      }),
    );
    expect(result).toEqual({
      available: true,
      sessions: [{ key: "agent:writer:older-than-global-first-40", label: "Owned work" }],
      nextOffset: 80,
    });
  });

  it("bounds concurrent member discovery and deduplicates identical owners", async () => {
    const people = Array.from({ length: 20 }, (_, i) => ({ github: [String(i)] }));
    identities(people.map((person) => profile(person.github[0]!, person.github[0]!)));
    let active = 0;
    let maximum = 0;
    const sessions = vi.fn(async () => {
      maximum = Math.max(maximum, ++active);
      await Promise.resolve();
      active--;
      return { available: true as const, sessions: [] };
    });
    const result = await listMemberWorkSessions(
      [...people, people[0]!],
      createPersonWorkSessions(sessions),
    );
    expect(result.size).toBe(20);
    expect(sessions).toHaveBeenCalledTimes(20);
    expect(maximum).toBeLessThanOrEqual(4);
    expect(dispatchGatewayMethod).toHaveBeenCalledTimes(1);
  });
});
