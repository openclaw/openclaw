import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGitCoauthorAttribution } from "./git-coauthor-attribution.js";
import {
  resolveRequestGitCoauthorPrompt,
  resolveSessionGitCoauthorPrompt,
} from "./git-coauthor-prompt.js";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("./git-coauthor-attribution.js", () => ({
  resolveGitCoauthorAttribution: vi.fn(),
}));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn }),
}));

describe("resolveSessionGitCoauthorPrompt", () => {
  const trailers = [
    "Co-authored-by: ada <20+ada@users.noreply.github.com>",
    "Co-authored-by: grace <10+grace@users.noreply.github.com>",
  ];
  const credit = { trailers, logins: ["ada", "grace"] };
  const session = { config: {}, agentId: "main", sessionKey: "agent:main:task" };
  const expectedPrompt = [
    "Git co-authors: add these exact trailers to every commit you make from this session.",
    ...trailers,
  ].join("\n");

  beforeEach(() => {
    vi.mocked(resolveGitCoauthorAttribution).mockReset();
    vi.mocked(resolveGitCoauthorAttribution).mockResolvedValue(credit);
    warn.mockReset();
  });

  it("places changing requester trailers only in the current-request prompt", async () => {
    const source = { config: {}, agentId: "main", sessionKey: "agent:main:main" };
    for (const [requesterProfileId, login, accountId] of [
      ["profile-c", "requester-c", 9101],
      ["profile-d", "requester-d", 9104],
    ] as const) {
      const trailer = `Co-authored-by: ${login} <${accountId}+${login}@users.noreply.github.com>`;
      vi.mocked(resolveGitCoauthorAttribution).mockResolvedValue({
        logins: [login],
        trailers: [trailer],
      });
      const prompt = await resolveRequestGitCoauthorPrompt({ ...source, requesterProfileId });
      expect(prompt).toContain(trailer);
      expect(prompt).not.toContain("unrelated-a");
      expect(resolveGitCoauthorAttribution).toHaveBeenLastCalledWith({
        ...source,
        requesterProfileId,
      });
    }
    vi.mocked(resolveGitCoauthorAttribution).mockResolvedValue(undefined);
    expect(await resolveRequestGitCoauthorPrompt(source)).toContain(
      "no host-verified requester trailer",
    );
  });

  it("keeps shared-main guidance stable without roster trailers", async () => {
    const prompt = await resolveSessionGitCoauthorPrompt({
      config: { session: { mainKey: "home" } },
      agentId: "work",
      sessionKey: "agent:work:home",
    });
    expect(prompt).toContain("Its participant roster is not a task's contributor list");
    expect(prompt).not.toContain("Co-authored-by:");
    expect(resolveGitCoauthorAttribution).not.toHaveBeenCalled();
    expect(
      await resolveSessionGitCoauthorPrompt({ ...session, sessionKey: "agent:main:main" }),
    ).toBe(prompt);
  });

  it.each<Parameters<typeof resolveSessionGitCoauthorPrompt>[0]>([
    { sessionKey: "agent:main:task" },
    { sessionKey: "agent:main:cron:nightly" },
    {
      config: {},
      agentId: "work",
      sessionKey: "agent:work:shared",
      sessionId: "work-session",
      storePath: "/isolated/session-store/sessions.json",
    },
  ])("pins credit to $sessionKey and its supplied store", async (overrides) => {
    const params = { ...session, ...overrides };
    expect(await resolveSessionGitCoauthorPrompt(params)).toBe(expectedPrompt);
    expect(resolveGitCoauthorAttribution).toHaveBeenCalledExactlyOnceWith({
      ...params,
      storePath: params.storePath,
    });
  });

  it.each([
    ["no config", { config: undefined }],
    ["no agent", { agentId: undefined }],
    ["no session", { sessionKey: undefined }],
    [
      "an isolated cron run",
      { sessionKey: "agent:main:cron:nightly:run:11111111-1111-1111-1111-111111111111" },
    ],
    ["an incognito session", { sessionKey: "agent:main:dashboard:incognito-two-turns" }],
  ] as const)("skips credit lookup with %s", async (_name, overrides) => {
    expect(await resolveSessionGitCoauthorPrompt({ ...session, ...overrides })).toBeUndefined();
    expect(resolveGitCoauthorAttribution).not.toHaveBeenCalled();
  });

  it("omits trailers when the session has nobody to credit", async () => {
    vi.mocked(resolveGitCoauthorAttribution).mockResolvedValue(undefined);
    expect(await resolveSessionGitCoauthorPrompt(session)).toBeUndefined();
    expect(resolveGitCoauthorAttribution).toHaveBeenCalledOnce();
  });

  it("keeps prompt building available and warns once when credit lookup fails", async () => {
    const error = new Error("participant store unavailable");
    vi.mocked(resolveGitCoauthorAttribution).mockRejectedValue(error);

    expect(await resolveSessionGitCoauthorPrompt(session)).toBeUndefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith("failed to resolve session Git co-authors", {
      error,
    });
  });
});
