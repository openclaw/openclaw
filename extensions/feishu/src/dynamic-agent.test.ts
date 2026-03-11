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
});
