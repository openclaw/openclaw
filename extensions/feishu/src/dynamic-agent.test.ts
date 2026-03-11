import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/feishu";
import { describe, expect, it, vi } from "vitest";
import { maybeCreateDynamicAgent } from "./dynamic-agent.js";

function createRuntime(writeConfigFile: ReturnType<typeof vi.fn>): PluginRuntime {
  return {
    config: {
      writeConfigFile,
    },
  } as unknown as PluginRuntime;
}

describe("maybeCreateDynamicAgent account-aware bindings", () => {
  it("adds account-scoped binding when only legacy account-less binding exists on non-default account", async () => {
    const writeConfigFile = vi.fn().mockResolvedValue(undefined);
    const runtime = createRuntime(writeConfigFile);
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "feishu-ou_user_1" }],
      },
      bindings: [
        {
          agentId: "feishu-ou_user_1",
          match: {
            channel: "feishu",
            peer: { kind: "direct", id: "ou_user_1" },
          },
        },
      ],
    };

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime,
      senderOpenId: "ou_user_1",
      accountId: "router-d",
      dynamicCfg: { enabled: true },
      log: () => {},
    });

    expect(result.created).toBe(true);
    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    expect(result.updatedCfg.bindings).toContainEqual({
      agentId: "feishu-ou_user_1",
      match: {
        channel: "feishu",
        accountId: "router-d",
        peer: { kind: "direct", id: "ou_user_1" },
      },
    });
  });

  it("treats legacy account-less binding as matching default account", async () => {
    const writeConfigFile = vi.fn().mockResolvedValue(undefined);
    const runtime = createRuntime(writeConfigFile);
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "feishu-ou_user_1" }],
      },
      bindings: [
        {
          agentId: "feishu-ou_user_1",
          match: {
            channel: "feishu",
            peer: { kind: "direct", id: "ou_user_1" },
          },
        },
      ],
    };

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime,
      senderOpenId: "ou_user_1",
      accountId: "default",
      dynamicCfg: { enabled: true },
      log: () => {},
    });

    expect(result.created).toBe(false);
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("writes explicit accountId when creating missing binding for existing agent", async () => {
    const writeConfigFile = vi.fn().mockResolvedValue(undefined);
    const runtime = createRuntime(writeConfigFile);
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "feishu-ou_user_2" }],
      },
      bindings: [],
    };

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime,
      senderOpenId: "ou_user_2",
      accountId: "router-d",
      dynamicCfg: { enabled: true },
      log: () => {},
    });

    expect(result.created).toBe(true);
    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    expect(result.updatedCfg.bindings).toEqual([
      {
        agentId: "feishu-ou_user_2",
        match: {
          channel: "feishu",
          accountId: "router-d",
          peer: { kind: "direct", id: "ou_user_2" },
        },
      },
    ]);
  });

  it("creates a new agent and account-scoped binding when both are missing", async () => {
    const writeConfigFile = vi.fn().mockResolvedValue(undefined);
    const runtime = createRuntime(writeConfigFile);
    const cfg: OpenClawConfig = { agents: { list: [] }, bindings: [] };
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-dynamic-agent-test-"));
    const workspaceTemplate = path.join(tempRoot, "workspace-{agentId}");
    const agentDirTemplate = path.join(tempRoot, "agents/{agentId}/agent");
    const agentId = "feishu-ou_user_3";
    const workspace = path.join(tempRoot, `workspace-${agentId}`);
    const agentDir = path.join(tempRoot, "agents", agentId, "agent");

    try {
      const result = await maybeCreateDynamicAgent({
        cfg,
        runtime,
        senderOpenId: "ou_user_3",
        accountId: "  Router/Prod  ",
        dynamicCfg: {
          enabled: true,
          workspaceTemplate,
          agentDirTemplate,
        },
        log: () => {},
      });

      expect(result.created).toBe(true);
      expect(result.agentId).toBe(agentId);
      expect(writeConfigFile).toHaveBeenCalledTimes(1);
      expect(result.updatedCfg.agents?.list).toContainEqual({
        id: agentId,
        workspace,
        agentDir,
      });
      expect(result.updatedCfg.bindings).toContainEqual({
        agentId,
        match: {
          channel: "feishu",
          accountId: "router-prod",
          peer: { kind: "direct", id: "ou_user_3" },
        },
      });
      await expect(fs.access(workspace)).resolves.toBeUndefined();
      await expect(fs.access(agentDir)).resolves.toBeUndefined();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
