import os from "node:os";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { spawnAcpDirect } from "./acp-spawn.js";

export function registerAcpSpawnPolicyTests(fixture: {
  spawn: typeof spawnAcpDirect;
  state: { cfg: OpenClawConfig };
  initializeSessionMock: unknown;
  upsertSessionEntryMock: unknown;
  callGatewayMock: unknown;
}) {
  it.each(["codex", undefined])(
    "refuses restricted cross-agent ACP targets, including the default (%s)",
    async (agentId) => {
      fixture.state.cfg.acp = { ...fixture.state.cfg.acp, defaultAgent: "codex" };
      const result = await fixture.spawn(
        { task: "inspect", agentId },
        { agentSessionKey: "agent:main:main", inheritedToolPolicySource: "sender" },
      );
      expect(result).toMatchObject({
        status: "forbidden",
        error: "This sender may only start hidden helpers of the same agent.",
      });
      expect(fixture.upsertSessionEntryMock).not.toHaveBeenCalled();
      expect(fixture.initializeSessionMock).not.toHaveBeenCalled();
    },
  );

  it("keeps a restricted same-agent ACP helper in the requester's root", async () => {
    const result = await fixture.spawn(
      { task: "inspect", agentId: "codex" },
      {
        agentSessionKey: "agent:codex:main",
        inheritedToolPolicySource: "sender",
        inheritedToolDenylist: ["browser"],
        workspaceDir: os.tmpdir(),
        sessionPermissionPolicy: { mode: "full", root: os.tmpdir() },
      },
    );
    expect(result.status).toBe("accepted");
    expect(fixture.initializeSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: os.tmpdir() }),
    );
    expect(fixture.upsertSessionEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        inheritedToolPolicySource: "sender",
        spawnDepth: 1,
        sessionRoot: os.tmpdir(),
        inheritedToolDeny: ["browser"],
      }),
    );
  });

  it("refuses ACP when a restricted helper's guarded root cannot be enforced", async () => {
    const result = await fixture.spawn(
      { task: "inspect", agentId: "codex" },
      {
        agentSessionKey: "agent:codex:main",
        inheritedToolPolicySource: "sender",
        sessionPermissionPolicy: { mode: "guarded", root: os.tmpdir() },
      },
    );
    expect(result).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("session root restrictions"),
    });
    expect(fixture.initializeSessionMock).not.toHaveBeenCalled();
  });

  it('forbids sandbox="require" for runtime=acp', async () => {
    const result = await fixture.spawn(
      { task: "inspect", agentId: "codex", sandbox: "require" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining('sandbox="require"'),
    });
    expect(fixture.callGatewayMock).not.toHaveBeenCalled();
    expect(fixture.initializeSessionMock).not.toHaveBeenCalled();
  });
}
