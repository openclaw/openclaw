import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const hoisted = vi.hoisted(() => {
  const resolveAllAgentSessionStoreTargetsMock = vi.fn();
  const loadSessionStoreMock = vi.fn();
  return {
    resolveAllAgentSessionStoreTargetsMock,
    loadSessionStoreMock,
  };
});

vi.mock("../../config/sessions/store-load.js", () => ({
  loadSessionStore: (storePath: string) => hoisted.loadSessionStoreMock(storePath),
}));

vi.mock("../../config/sessions/targets.js", () => ({
  resolveAllAgentSessionStoreTargets: (cfg: OpenClawConfig, opts: unknown) =>
    hoisted.resolveAllAgentSessionStoreTargetsMock(cfg, opts),
}));
let listAcpSessionEntries: typeof import("./session-meta.js").listAcpSessionEntries;
let readAcpSessionEntry: typeof import("./session-meta.js").readAcpSessionEntry;

describe("session-meta", () => {
  beforeAll(async () => {
    ({ listAcpSessionEntries, readAcpSessionEntry } = await import("./session-meta.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back from thread-scoped ACP aliases to the base ACP session entry", () => {
    const cfg = {
      session: {
        store: "/custom/sessions/{agentId}.json",
      },
    } as OpenClawConfig;
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:codex:acp:base-session": {
        sessionId: "session-1",
        updatedAt: 123,
        acp: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "acpx:v2:example",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 123,
        },
      },
      "agent:codex:acp:base-session:thread:7657523082:4403": {
        sessionId: "session-2",
        updatedAt: 124,
        deliveryContext: {
          channel: "telegram",
          to: "telegram:7657523082",
          accountId: "default",
          threadId: "4403",
        },
      },
    });

    const entry = readAcpSessionEntry({
      cfg,
      sessionKey: "agent:codex:acp:base-session:thread:7657523082:4403",
    });

    expect(hoisted.loadSessionStoreMock).toHaveBeenCalledWith("/custom/sessions/codex.json");
    expect(entry).toEqual(
      expect.objectContaining({
        cfg,
        storePath: "/custom/sessions/codex.json",
        sessionKey: "agent:codex:acp:base-session:thread:7657523082:4403",
        storeSessionKey: "agent:codex:acp:base-session",
        acp: expect.objectContaining({
          agent: "codex",
          backend: "acpx",
          runtimeSessionName: "acpx:v2:example",
        }),
      }),
    );
  });

  it("reads ACP sessions from resolved configured store targets", async () => {
    const cfg = {
      session: {
        store: "/custom/sessions/{agentId}.json",
      },
    } as OpenClawConfig;
    hoisted.resolveAllAgentSessionStoreTargetsMock.mockResolvedValue([
      {
        agentId: "ops",
        storePath: "/custom/sessions/ops.json",
      },
    ]);
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:ops:acp:s1": {
        updatedAt: 123,
        acp: {
          backend: "acpx",
          agent: "ops",
          mode: "persistent",
          state: "idle",
        },
      },
    });

    const entries = await listAcpSessionEntries({ cfg });

    expect(hoisted.resolveAllAgentSessionStoreTargetsMock).toHaveBeenCalledWith(cfg, undefined);
    expect(hoisted.loadSessionStoreMock).toHaveBeenCalledWith("/custom/sessions/ops.json");
    expect(entries).toEqual([
      expect.objectContaining({
        cfg,
        storePath: "/custom/sessions/ops.json",
        sessionKey: "agent:ops:acp:s1",
        storeSessionKey: "agent:ops:acp:s1",
      }),
    ]);
  });
});
