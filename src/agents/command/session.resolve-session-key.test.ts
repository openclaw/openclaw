import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";

const hoisted = vi.hoisted(() => ({
  loadSessionStoreMock: vi.fn<(storePath: string) => Record<string, SessionEntry>>(),
  listAgentIdsMock: vi.fn<() => string[]>(),
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    loadSessionStore: (storePath: string) => hoisted.loadSessionStoreMock(storePath),
    resolveStorePath: (store?: string, params?: { agentId?: string }) =>
      `/stores/${params?.agentId ?? "main"}.json`,
    resolveAgentIdFromSessionKey: () => "main",
    resolveExplicitAgentSessionKey: () => undefined,
  };
});

vi.mock("../agent-scope.js", () => ({
  listAgentIds: () => hoisted.listAgentIdsMock(),
}));

const { resolveSessionKeyForRequest, resolveStoredSessionKeyForSessionId } =
  await import("./session.js");

describe("resolveSessionKeyForRequest", () => {
  beforeEach(() => {
    hoisted.loadSessionStoreMock.mockReset();
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
    hoisted.loadSessionStoreMock.mockImplementation((storePath) => {
      if (storePath === "/stores/main.json") {
        return mainStore;
      }
      if (storePath === "/stores/other.json") {
        return otherStore;
      }
      return {};
    });

    const result = resolveSessionKeyForRequest({
      cfg: {
        session: {
          store: "/stores/{agentId}.json",
        },
      } satisfies OpenClawConfig,
      sessionId: "sid",
    });

    expect(result.sessionKey).toBe("agent:main:main");
    expect(result.sessionStore).toBe(mainStore);
    expect(result.storePath).toBe("/stores/main.json");
  });

  it("keeps a cross-store structural winner over a newer local fuzzy duplicate", () => {
    const mainStore = {
      "agent:main:main": { sessionId: "sid", updatedAt: 20 },
    } satisfies Record<string, SessionEntry>;
    const otherStore = {
      "agent:other:acp:sid": { sessionId: "sid", updatedAt: 10 },
    } satisfies Record<string, SessionEntry>;
    hoisted.loadSessionStoreMock.mockImplementation((storePath) => {
      if (storePath === "/stores/main.json") {
        return mainStore;
      }
      if (storePath === "/stores/other.json") {
        return otherStore;
      }
      return {};
    });

    const result = resolveSessionKeyForRequest({
      cfg: {
        session: {
          store: "/stores/{agentId}.json",
        },
      } satisfies OpenClawConfig,
      sessionId: "sid",
    });

    expect(result.sessionKey).toBe("agent:other:acp:sid");
    expect(result.sessionStore).toBe(otherStore);
    expect(result.storePath).toBe("/stores/other.json");
  });

  it("scopes stored session-key lookup to the requested agent store", () => {
    const embeddedAgentStore = {
      "agent:embedded-agent:main": { sessionId: "other-session", updatedAt: 2 },
      "agent:embedded-agent:work": { sessionId: "resume-agent-1", updatedAt: 1 },
    } satisfies Record<string, SessionEntry>;
    hoisted.loadSessionStoreMock.mockImplementation((storePath) => {
      if (storePath === "/stores/embedded-agent.json") {
        return embeddedAgentStore;
      }
      return {};
    });

    const result = resolveStoredSessionKeyForSessionId({
      cfg: {
        session: {
          store: "/stores/{agentId}.json",
        },
      } satisfies OpenClawConfig,
      sessionId: "resume-agent-1",
      agentId: "embedded-agent",
    });

    expect(result.sessionKey).toBe("agent:embedded-agent:work");
    expect(result.sessionStore).toBe(embeddedAgentStore);
    expect(result.storePath).toBe("/stores/embedded-agent.json");
    expect(hoisted.loadSessionStoreMock).toHaveBeenCalledTimes(1);
  });
});
