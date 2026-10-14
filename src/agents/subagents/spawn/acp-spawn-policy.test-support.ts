import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
        // The policy root is persisted as this child's working directory even
        // though the request named no cwd. Working-directory readers must read
        // that as inherited rather than as an explicit request — see
        // `buildSharedCwdIndex` in `subagent-list.ts`, which keys that
        // exemption on `inheritedToolPolicySource` and so leaves the enforced
        // directory on the entry.
        spawnedCwd: os.tmpdir(),
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

  // Explicit-working-directory persistence. These live here rather than inline
  // in `acp-spawn.test.ts` because that file is already far over the
  // `max-lines` cap and `check:line-cap-ratchet` rejects any growth in it; this
  // module already owns what root an ACP spawn receives and what the session
  // writer records for it, and already holds both mocks.
  const spawnedCwdFromCreate = () =>
    (
      (fixture.upsertSessionEntryMock as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1] as {
        spawnedCwd?: string;
      }
    )?.spawnedCwd;

  it("persists an explicit ACP cwd so working-directory readers see it like a native child", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-spawn-cwd-"));
    const explicitCwd = path.join(workspaceRoot, "shared-checkout");
    await fs.mkdir(explicitCwd, { recursive: true });
    try {
      fixture.state.cfg.acp = { ...fixture.state.cfg.acp, allowedAgents: ["codex", "claude-code"] };
      fixture.state.cfg.agents = {
        entries: {
          main: { workspace: path.join(workspaceRoot, "main") },
          "claude-code": { workspace: path.join(workspaceRoot, "claude-code") },
        },
      };
      const result = await fixture.spawn(
        {
          task: "Inspect the queue owner state",
          agentId: "claude-code",
          mode: "run",
          cwd: explicitCwd,
        },
        { agentSessionKey: "agent:main:main" },
      );

      expect(result.status).toBe("accepted");
      expect(spawnedCwdFromCreate()).toBe(explicitCwd);
      expect(fixture.initializeSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({ agent: "claude-code", cwd: explicitCwd }),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("records no spawnedCwd when an ACP child inherits the target agent workspace", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-spawn-cwd-"));
    const targetWorkspace = path.join(workspaceRoot, "claude-code");
    await fs.mkdir(targetWorkspace, { recursive: true });
    try {
      fixture.state.cfg.acp = { ...fixture.state.cfg.acp, allowedAgents: ["codex", "claude-code"] };
      fixture.state.cfg.agents = {
        entries: {
          main: { workspace: path.join(workspaceRoot, "main") },
          "claude-code": { workspace: targetWorkspace },
        },
      };
      const result = await fixture.spawn(
        { task: "Inspect the queue owner state", agentId: "claude-code", mode: "run" },
        { agentSessionKey: "agent:main:main" },
      );

      expect(result.status).toBe("accepted");
      // Inheritance is not an explicit cwd: the advisory must stay silent for
      // children that merely share the workspace they were given.
      expect(spawnedCwdFromCreate()).toBeUndefined();
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
}
