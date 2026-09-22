import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { withEnvAsync } from "../test-utils/env.js";
import { registerSandboxBackend } from "./sandbox/backend.js";
import { resolveSandboxContext } from "./sandbox/context.js";
import { resolveSubagentSessionAttachmentRootDir } from "./subagents/subagent-attachment-paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("isolates a session attachment projection from sibling agent-scoped sessions", async () => {
  const stateDir = tempDirs.make("openclaw-attachment-state-");
  const workspaceDir = path.join(stateDir, "workspace");
  const attachedSessionKey = "agent:main:subagent:attached";
  const siblingSessionKey = "agent:main:subagent:sibling";
  const attachmentRoot = resolveSubagentSessionAttachmentRootDir({
    agentId: "main",
    childSessionKey: attachedSessionKey,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  const backendFactory = vi.fn(async (params) => ({
    id: "attachment-scope-backend",
    runtimeId: `runtime-${params.scopeKey}`,
    runtimeLabel: "Attachment Scope Runtime",
    workdir: "/workspace",
    buildExecSpec: async () => ({
      argv: ["attachment-scope-backend", "exec"],
      env: {},
      stdinMode: "pipe-closed" as const,
    }),
    runShellCommand: async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: 0,
    }),
  }));
  const restore = registerSandboxBackend("attachment-scope-backend", {
    capabilities: { readOnlyResourceMounts: true },
    factory: backendFactory,
  });
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          backend: "attachment-scope-backend",
          scope: "agent",
          workspaceAccess: "none",
          prune: { idleHours: 0, maxAgeDays: 0 },
        },
      },
    },
  };

  try {
    await fs.mkdir(workspaceDir, { recursive: true });
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const beforeAttachment = await resolveSandboxContext({
        config: cfg,
        sessionKey: attachedSessionKey,
        workspaceDir,
      });
      expect(beforeAttachment?.readOnlyResourceMounts).toBeUndefined();
      await fs.mkdir(attachmentRoot, { recursive: true });
      await fs.writeFile(path.join(attachmentRoot, "proof.txt"), "authorized");
      const attached = await resolveSandboxContext({
        config: cfg,
        sessionKey: attachedSessionKey,
        workspaceDir,
      });
      const sibling = await resolveSandboxContext({
        config: cfg,
        sessionKey: siblingSessionKey,
        workspaceDir,
      });

      expect(attached?.readOnlyResourceMounts).toEqual([
        {
          hostPath: await fs.realpath(attachmentRoot),
          containerPath: "/openclaw/attachments",
        },
      ]);
      expect(sibling?.readOnlyResourceMounts).toBeUndefined();
      const [beforeCall, attachedCall, siblingCall] = backendFactory.mock.calls.map(
        ([call]) => call,
      );
      expect(beforeCall?.scopeKey).toBe(siblingCall?.scopeKey);
      expect(attachedCall?.scopeKey).not.toBe(siblingCall?.scopeKey);
      expect(attachedCall?.readOnlyResourceMounts).toHaveLength(1);
      expect(siblingCall?.readOnlyResourceMounts).toBeUndefined();
    });
  } finally {
    restore();
  }
});
