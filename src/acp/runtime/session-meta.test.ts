import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const hoisted = vi.hoisted(() => {
  const resolveAllAgentSessionDatabaseTargetsMock = vi.fn();
  const listSessionEntriesMock = vi.fn();
  return {
    resolveAllAgentSessionDatabaseTargetsMock,
    listSessionEntriesMock,
  };
});

vi.mock("../../config/sessions/store.js", () => ({
  listSessionEntries: (params: { agentId: string }) => hoisted.listSessionEntriesMock(params),
  getSessionEntry: vi.fn(() => undefined),
}));

vi.mock("../../config/sessions/targets.js", () => ({
  resolveAllAgentSessionDatabaseTargets: (cfg: OpenClawConfig, opts: unknown) =>
    hoisted.resolveAllAgentSessionDatabaseTargetsMock(cfg, opts),
}));
let listAcpSessionEntries: typeof import("./session-meta.js").listAcpSessionEntries;

describe("listAcpSessionEntries", () => {
  beforeAll(async () => {
    ({ listAcpSessionEntries } = await import("./session-meta.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads ACP sessions from resolved configured store targets", async () => {
    const cfg = {
      session: {},
    } as OpenClawConfig;
    hoisted.resolveAllAgentSessionDatabaseTargetsMock.mockResolvedValue([
      {
        agentId: "ops",
        storePath: "/custom/sessions/ops.json",
      },
    ]);
    hoisted.listSessionEntriesMock.mockReturnValue([
      {
        sessionKey: "agent:ops:acp:s1",
        entry: {
          updatedAt: 123,
          acp: {
            backend: "acpx",
            agent: "ops",
            mode: "persistent",
            state: "idle",
          },
        },
      },
    ]);

    const entries = await listAcpSessionEntries({ cfg });

    expect(hoisted.resolveAllAgentSessionDatabaseTargetsMock).toHaveBeenCalledWith(cfg, undefined);
    expect(hoisted.listSessionEntriesMock).toHaveBeenCalledWith({ agentId: "ops" });
    expect(entries).toEqual([
      expect.objectContaining({
        cfg,
        agentId: "ops",
        sessionKey: "agent:ops:acp:s1",
        storeSessionKey: "agent:ops:acp:s1",
      }),
    ]);
  });
});
