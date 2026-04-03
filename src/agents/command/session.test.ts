import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";

const hoisted = vi.hoisted(() => ({
  clearBootstrapSnapshotOnSessionRolloverMock: vi.fn(),
  evaluateSessionFreshnessMock: vi.fn(),
  loadSessionStoreMock: vi.fn<(storePath: string) => Record<string, SessionEntry>>(),
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    evaluateSessionFreshness: (params: unknown) => hoisted.evaluateSessionFreshnessMock(params),
    loadSessionStore: (storePath: string) => hoisted.loadSessionStoreMock(storePath),
    resolveAgentIdFromSessionKey: () => "business-main",
    resolveChannelResetConfig: () => null,
    resolveExplicitAgentSessionKey: () => undefined,
    resolveSessionKey: () => "agent:business-main:main",
    resolveSessionResetPolicy: () => ({ kind: "stub" }),
    resolveSessionResetType: () => ({ kind: "stub" }),
    resolveStorePath: () => "/stores/business-main.json",
  };
});

vi.mock("../agent-scope.js", () => ({
  listAgentIds: () => ["business-main"],
}));

vi.mock("../bootstrap-cache.js", () => ({
  clearBootstrapSnapshotOnSessionRollover: (params: unknown) =>
    hoisted.clearBootstrapSnapshotOnSessionRolloverMock(params),
}));

const { resolveSession } = await import("./session.js");

describe("resolveSession", () => {
  beforeEach(() => {
    hoisted.clearBootstrapSnapshotOnSessionRolloverMock.mockReset();
    hoisted.evaluateSessionFreshnessMock.mockReset();
    hoisted.loadSessionStoreMock.mockReset();
  });

  it("rolls the main session forward when an explicit new session id is requested", () => {
    const store = {
      "agent:business-main:main": {
        sessionId: "old-session",
        updatedAt: 123,
        thinkingLevel: "medium",
        verboseLevel: "on",
        cliSessionIds: { "github-copilot": "old-cli-session" },
      },
    } satisfies Record<string, SessionEntry>;
    hoisted.loadSessionStoreMock.mockReturnValue(store);
    hoisted.evaluateSessionFreshnessMock.mockReturnValue({ fresh: true });

    const result = resolveSession({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:business-main:main",
      sessionId: "new-session",
    });

    expect(result.sessionId).toBe("new-session");
    expect(result.isNewSession).toBe(true);
    expect(result.sessionEntry).toBeUndefined();
    expect(result.persistedThinking).toBeUndefined();
    expect(result.persistedVerbose).toBeUndefined();
    expect(store["agent:business-main:main"]).toBeUndefined();
    expect(hoisted.clearBootstrapSnapshotOnSessionRolloverMock).toHaveBeenCalledWith({
      sessionKey: "agent:business-main:main",
      previousSessionId: "old-session",
    });
  });

  it("preserves continuation when the explicit session id matches the stored session", () => {
    const sessionEntry = {
      sessionId: "same-session",
      updatedAt: 123,
      thinkingLevel: "medium",
      verboseLevel: "on",
    } satisfies SessionEntry;
    const store = {
      "agent:business-main:main": sessionEntry,
    } satisfies Record<string, SessionEntry>;
    hoisted.loadSessionStoreMock.mockReturnValue(store);
    hoisted.evaluateSessionFreshnessMock.mockReturnValue({ fresh: false });

    const result = resolveSession({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:business-main:main",
      sessionId: "same-session",
    });

    expect(result.sessionId).toBe("same-session");
    expect(result.isNewSession).toBe(false);
    expect(result.sessionEntry).toEqual(sessionEntry);
    expect(result.persistedThinking).toBe("medium");
    expect(result.persistedVerbose).toBe("on");
    expect(store["agent:business-main:main"]).toEqual(sessionEntry);
    expect(hoisted.clearBootstrapSnapshotOnSessionRolloverMock).toHaveBeenCalledWith({
      sessionKey: "agent:business-main:main",
      previousSessionId: undefined,
    });
  });

  it("reuses a fresh stored main session when no explicit session id is passed", () => {
    const sessionEntry = {
      sessionId: "existing-session",
      updatedAt: 123,
      thinkingLevel: "low",
      verboseLevel: "off",
    } satisfies SessionEntry;
    const store = {
      "agent:business-main:main": sessionEntry,
    } satisfies Record<string, SessionEntry>;
    hoisted.loadSessionStoreMock.mockReturnValue(store);
    hoisted.evaluateSessionFreshnessMock.mockReturnValue({ fresh: true });

    const result = resolveSession({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:business-main:main",
    });

    expect(result.sessionId).toBe("existing-session");
    expect(result.isNewSession).toBe(false);
    expect(result.sessionEntry).toEqual(sessionEntry);
    expect(result.persistedThinking).toBe("low");
    expect(result.persistedVerbose).toBe("off");
  });
});
