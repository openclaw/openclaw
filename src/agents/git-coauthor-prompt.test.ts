import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGitCoauthorAttribution } from "./git-coauthor-attribution.js";
import { resolveSessionGitCoauthorPrompt } from "./git-coauthor-prompt.js";

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
  const expectedPrompt =
    "Git co-authors: add these exact trailers to every commit you make from this session.\n" +
    "Co-authored-by: ada <20+ada@users.noreply.github.com>\n" +
    "Co-authored-by: grace <10+grace@users.noreply.github.com>";

  beforeEach(() => {
    vi.mocked(resolveGitCoauthorAttribution).mockReset();
    warn.mockReset();
  });

  it.each(["agent:main:main", "agent:main:cron:nightly"])(
    "resolves credit for a stable session %s",
    (sessionKey) => {
      vi.mocked(resolveGitCoauthorAttribution).mockReturnValue({
        trailers,
        logins: ["ada", "grace"],
      });
      const params = { config: {}, agentId: "main", sessionKey };

      expect(resolveSessionGitCoauthorPrompt(params)).toBe(expectedPrompt);
      expect(resolveGitCoauthorAttribution).toHaveBeenCalledExactlyOnceWith({
        ...params,
        storePath: undefined,
      });
    },
  );

  it("preserves an explicit session-store path", () => {
    vi.mocked(resolveGitCoauthorAttribution).mockReturnValue({
      trailers,
      logins: ["ada", "grace"],
    });
    const params = {
      config: {},
      agentId: "work",
      sessionKey: "agent:work:shared",
      storePath: "/isolated/session-store/sessions.json",
    };

    expect(resolveSessionGitCoauthorPrompt(params)).toBe(expectedPrompt);
    expect(resolveGitCoauthorAttribution).toHaveBeenCalledExactlyOnceWith(params);
  });

  it.each([
    { name: "no config", config: undefined, agentId: "main", sessionKey: "agent:main:main" },
    { name: "no agent", config: {}, agentId: undefined, sessionKey: "agent:main:main" },
    { name: "no session", config: {}, agentId: "main", sessionKey: undefined },
    {
      name: "an isolated cron run",
      config: {},
      agentId: "main",
      sessionKey: "agent:main:cron:nightly:run:11111111-1111-1111-1111-111111111111",
    },
    {
      name: "an incognito session",
      config: {},
      agentId: "main",
      sessionKey: "agent:main:dashboard:incognito-two-turns",
    },
  ])("skips credit lookup with $name", ({ config, agentId, sessionKey }) => {
    vi.mocked(resolveGitCoauthorAttribution).mockReturnValue({
      trailers,
      logins: ["ada", "grace"],
    });

    expect(resolveSessionGitCoauthorPrompt({ config, agentId, sessionKey })).toBeUndefined();
    expect(resolveGitCoauthorAttribution).not.toHaveBeenCalled();
  });

  it("omits trailers when the session has nobody to credit", () => {
    expect(
      resolveSessionGitCoauthorPrompt({
        config: {},
        agentId: "main",
        sessionKey: "agent:main:main",
      }),
    ).toBeUndefined();
    expect(resolveGitCoauthorAttribution).toHaveBeenCalledOnce();
  });

  it("keeps prompt building available and warns once when credit lookup fails", () => {
    const error = new Error("participant store unavailable");
    vi.mocked(resolveGitCoauthorAttribution).mockImplementation(() => {
      throw error;
    });

    expect(
      resolveSessionGitCoauthorPrompt({
        config: {},
        agentId: "main",
        sessionKey: "agent:main:main",
      }),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith("failed to resolve session Git co-authors", {
      error,
    });
  });
});
