import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";

const hoisted = vi.hoisted(() => ({
  listSessionRowsMock: vi.fn<(agentId: string) => Record<string, SessionEntry>>(),
  listAgentIdsMock: vi.fn<() => string[]>(),
}));

vi.mock("../../config/sessions/store.js", () => ({
  listSessionEntries: (params: { agentId: string }) =>
    Object.entries(hoisted.listSessionRowsMock(params.agentId) ?? {}).map(
      ([sessionKey, entry]) => ({
        sessionKey,
        entry,
      }),
    ),
}));

vi.mock("../../config/sessions/main-session.js", () => ({
  resolveAgentIdFromSessionKey: () => "main",
  resolveExplicitAgentSessionKey: () => undefined,
}));

vi.mock("../agent-scope.js", () => ({
  listAgentIds: () => hoisted.listAgentIdsMock(),
  resolveDefaultAgentId: () => "main",
}));

const { resolveSessionKeyForRequest, resolveStoredSessionKeyForSessionId } =
  await import("./session.js");

function mockSessionStores(storesByAgentId: Record<string, Record<string, SessionEntry>>): void {
  hoisted.listSessionRowsMock.mockImplementation((agentId) => storesByAgentId[agentId] ?? {});
}

function expectResolvedRequestSession(params: {
  sessionId: string;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
  agentId: string;
}): void {
  const result = resolveSessionKeyForRequest({
    cfg: {
      session: {},
    } satisfies OpenClawConfig,
    sessionId: params.sessionId,
  });

  expect(result.sessionKey).toBe(params.sessionKey);
  expect(result.sessionStore).toEqual(params.sessionStore);
  expect(result.agentId).toBe(params.agentId);
}

describe("resolveSessionKeyForRequest", () => {
  beforeEach(() => {
    hoisted.listSessionRowsMock.mockReset();
    hoisted.listAgentIdsMock.mockReset();
    hoisted.listAgentIdsMock.mockReturnValue(["main", "other"]);
  });

  it("prefers the current store when equal duplicates exist across stores", () => {
    const mainStore = {
      "agent:main:main": { sessionId: "sid", updatedAt: 10 },
    } satisfies Record<string, SessionEntry>;
    const otherStore = {
      "agent:other:main": { sessionId: "sid", updatedAt: 10 },
    } satisfies Record<string, SessionEntry>;
    mockSessionStores({
      main: mainStore,
      other: otherStore,
    });

    expectResolvedRequestSession({
      sessionId: "sid",
      sessionKey: "agent:main:main",
      sessionStore: mainStore,
      agentId: "main",
    });
  });

  it("keeps a cross-store structural winner over a newer local fuzzy duplicate", () => {
    const mainStore = {
      "agent:main:main": { sessionId: "sid", updatedAt: 20 },
    } satisfies Record<string, SessionEntry>;
    const otherStore = {
      "agent:other:acp:sid": { sessionId: "sid", updatedAt: 10 },
    } satisfies Record<string, SessionEntry>;
    mockSessionStores({
      main: mainStore,
      other: otherStore,
    });

    expectResolvedRequestSession({
      sessionId: "sid",
      sessionKey: "agent:other:acp:sid",
      sessionStore: otherStore,
      agentId: "other",
    });
  });

  it("scopes stored session-key lookup to the requested agent store", () => {
    const embeddedAgentStore = {
      "agent:embedded-agent:main": { sessionId: "other-session", updatedAt: 2 },
      "agent:embedded-agent:work": { sessionId: "resume-agent-1", updatedAt: 1 },
    } satisfies Record<string, SessionEntry>;
    hoisted.listSessionRowsMock.mockImplementation((agentId) => {
      if (agentId === "embedded-agent") {
        return embeddedAgentStore;
      }
      return {};
    });

    const result = resolveStoredSessionKeyForSessionId({
      cfg: {
        session: {},
      } satisfies OpenClawConfig,
      sessionId: "resume-agent-1",
      agentId: "embedded-agent",
    });

    expect(result.sessionKey).toBe("agent:embedded-agent:work");
    expect(result.sessionStore).toEqual(embeddedAgentStore);
    expect(result.agentId).toBe("embedded-agent");
    expect(hoisted.listSessionRowsMock).toHaveBeenCalledTimes(1);
  });
});
