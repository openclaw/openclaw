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
  it.each([{ allowed: true }, { allowed: false }])(
    "drops the requester ceiling only for an allowed configured ACP agent (allowed=$allowed)",
    async ({ allowed }) => {
      fixture.state.cfg.agents = {
        entries: {
          main: { subagents: { allowAgents: allowed ? ["coder"] : [] } },
          coder: { runtime: { type: "acp", acp: { agent: "codex" } } },
        },
      };
      const result = await fixture.spawn(
        { task: "Implement the change", agentId: "coder" },
        {
          agentSessionKey: "agent:main:main",
          inheritedToolAllowlist: ["read", "sessions_spawn"],
          inheritedToolDenylist: ["write", "exec"],
        },
      );
      if (allowed) {
        expect(result.status).toBe("accepted");
        expect(result.childSessionKey).toMatch(/^agent:coder:acp:/);
        expect(fixture.upsertSessionEntryMock).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ inheritedToolPolicyVersion: 1 }),
        );
        expect(fixture.upsertSessionEntryMock).toHaveBeenCalledWith(
          expect.anything(),
          expect.not.objectContaining({ inheritedToolAllow: expect.anything() }),
        );
        expect(fixture.upsertSessionEntryMock).toHaveBeenCalledWith(
          expect.anything(),
          expect.not.objectContaining({ inheritedToolDeny: expect.anything() }),
        );
      } else {
        expect(result).toMatchObject({
          status: "forbidden",
          error: expect.stringContaining("agentId is not allowed"),
        });
        expect(fixture.initializeSessionMock).not.toHaveBeenCalled();
        expect(fixture.upsertSessionEntryMock).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { policy: { inheritedToolDenylist: ["exec"] }, error: "requester denies exec" },
    { policy: { inheritedToolDenylist: ["group:fs"] }, error: "requester denies apply_patch" },
    { policy: { inheritedToolDenylist: ["exec*"] }, error: "requester denies exec" },
    {
      policy: { inheritedToolAllowlist: ["read", "sessions_spawn"] },
      error: "requester does not allow apply_patch",
    },
  ])(
    "keeps the requester ceiling for an external ACP harness: $error",
    async ({ policy, error }) => {
      const result = await fixture.spawn(
        { task: "Inspect the project", agentId: "codex" },
        { agentSessionKey: "agent:main:main", ...policy },
      );
      expect(result).toMatchObject({ status: "forbidden", error: expect.stringContaining(error) });
      expect(fixture.initializeSessionMock).not.toHaveBeenCalled();
      expect(fixture.upsertSessionEntryMock).not.toHaveBeenCalled();
    },
  );

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
