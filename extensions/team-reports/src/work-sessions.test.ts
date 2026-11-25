import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import {
  createPersonWorkSessions,
  listMemberWorkSessions,
  listWorkSessions,
} from "./work-sessions.js";

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({ dispatchGatewayMethod: vi.fn() }));
const dispatch = vi.mocked(dispatchGatewayMethod);
beforeEach(() => dispatch.mockReset());
const respond = (payload: unknown) => dispatch.mockResolvedValueOnce({ ok: true, payload });

it("requests owned sessions and projects only link metadata, excluding incognito", async () => {
  respond({
    sessions: [
      {
        key: "agent:writer:work",
        owner: { actor: { type: "human", label: "Alice" } },
        status: "running",
        lastMessagePreview: "Not report evidence",
      },
      { key: "agent:writer:private", incognito: true },
    ],
    hasMore: true,
    nextOffset: 80,
  });
  const result = await listWorkSessions(40, undefined, "alice");
  expect(dispatch).toHaveBeenCalledWith("sessions.list", {
    profileRelation: { profileId: "alice", relationship: "owned" },
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
  expect(result).toEqual({
    available: true,
    sessions: [
      {
        key: "agent:writer:work",
        owner: { actor: { type: "human", label: "Alice" } },
        status: "running",
      },
    ],
    nextOffset: 80,
  });
});

it.each([false, true])("returns unavailable for failed discovery (throw=%s)", async (throws) => {
  if (throws) {
    dispatch.mockRejectedValueOnce(new Error("private transport detail"));
  } else {
    dispatch.mockResolvedValueOnce({ ok: false });
  }
  expect(await listWorkSessions()).toEqual({ available: false });
});
const profile = (id: string, login: string | null, mergedInto?: string | null, host?: string) => ({
  id,
  mergedInto: mergedInto ?? null,
  githubIdentity: login ? { ...(host ? { host } : {}), login } : null,
});
const identities = (profiles: ReturnType<typeof profile>[]) => respond({ profiles });
async function expectNoSessions(alias = "alice", reason?: string) {
  const sessions = vi.fn();
  expect(await createPersonWorkSessions(sessions)({ github: [alias] })).toEqual({
    available: false,
    ...(reason ? { reason } : {}),
  });
  expect(sessions).not.toHaveBeenCalled();
}

it("resolves aliases case-insensitively through merges and deduplicates owner pages per request", async () => {
  identities([profile("old", "Old-Alice", "alice"), profile("alice", "Alice")]);
  const sessions = vi.fn().mockResolvedValue({ available: true, sessions: [] });
  const list = createPersonWorkSessions(sessions);
  await Promise.all([list({ github: ["OLD-alice", "ALICE"] }), list({ github: ["Alice"] })]);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(sessions).toHaveBeenCalledExactlyOnceWith(0, 3, "alice");
  await list({ github: ["alice"] }, 40, 40);
  expect(sessions).toHaveBeenLastCalledWith(40, 40, "alice");
  identities([profile("new-owner", "Alice")]);
  await createPersonWorkSessions(sessions)({ github: ["alice"] });
  expect(sessions).toHaveBeenLastCalledWith(0, 3, "new-owner");
});

it.each([
  [[profile("name-only", null)], "unlinked", "name-only"],
  [[profile("enterprise", "Alice", null, "ghe.example.test")], "unlinked", "alice"],
  [[profile("a", "Alice", "missing")], "ambiguous", "alice"],
  [[profile("a", "Alice", "b"), profile("b", null, "a")], "ambiguous", "alice"],
] as const)("never queries unfiltered sessions for %j (%s)", async (profiles, reason, alias) => {
  identities([...profiles]);
  await expectNoSessions(alias, reason);
});

it.each([undefined, "github.com"])(
  "discovers only the public member work across a login collision (host=%s)",
  async (host) => {
    identities([
      profile("enterprise", "Alice", null, "ghe.example.test"),
      profile("public", "ALICE", null, host),
    ]);
    respond({ sessions: [{ key: "agent:writer:public" }] });

    const result = await listMemberWorkSessions(
      [{ github: ["alice"] }],
      createPersonWorkSessions(listWorkSessions),
    );
    expect(dispatch).toHaveBeenLastCalledWith(
      "sessions.list",
      expect.objectContaining({
        profileRelation: { profileId: "public", relationship: "owned" },
      }),
    );
    expect(result.get("alice")).toEqual({
      available: true,
      sessions: [{ key: "agent:writer:public" }],
    });
  },
);

it("distinguishes unavailable identity dispatch from unlinked and empty owned sessions", async () => {
  dispatch.mockRejectedValueOnce(new Error("private detail"));
  await expectNoSessions();
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
  expect(dispatch).toHaveBeenCalledTimes(1);
});
