// Feishu tests cover dynamic agent plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import { maybeCreateDynamicAgent } from "./dynamic-agent.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-agent-"));
});

afterEach(async () => {
  await fs.promises.rm(tempRoot, { recursive: true, force: true });
});

function createRuntime(currentCfg?: OpenClawConfig) {
  let runtimeCfg = structuredClone(currentCfg ?? ({} as OpenClawConfig));
  const mutateConfigFile = vi.fn(
    async (params: {
      mutate: (
        draft: OpenClawConfig,
        context: { snapshot: never; previousHash: null },
      ) => unknown | Promise<unknown>;
    }) => {
      const draft = structuredClone(runtimeCfg);
      const result = await params.mutate(draft, { snapshot: {} as never, previousHash: null });
      runtimeCfg = draft;
      return { nextConfig: runtimeCfg, result };
    },
  );
  return {
    runtime: {
      config: {
        mutateConfigFile,
        current: vi.fn(() => runtimeCfg),
      },
    } as unknown as PluginRuntime,
    mutateConfigFile,
  };
}

function createDynamicConfig() {
  return {
    enabled: true,
    workspaceTemplate: path.join(tempRoot, "workspace-{agentId}"),
    agentDirTemplate: path.join(tempRoot, "agent-{agentId}"),
  };
}

async function pathExists(target: string): Promise<boolean> {
  return fs.promises
    .stat(target)
    .then(() => true)
    .catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw err;
    });
}

describe("maybeCreateDynamicAgent", () => {
  it("does not persist dynamic agents when config writes are disabled", async () => {
    const { runtime, mutateConfigFile } = createRuntime();
    const dynamicCfg = createDynamicConfig();

    const result = await maybeCreateDynamicAgent({
      cfg: {
        channels: { feishu: { configWrites: false } },
        agents: { list: [] },
        bindings: [],
      } as OpenClawConfig,
      runtime,
      senderOpenId: "ou_sender",
      dynamicCfg,
      configWritesAllowed: false,
      log: vi.fn(),
    });

    expect(result).toEqual({
      created: false,
      updatedCfg: {
        channels: { feishu: { configWrites: false } },
        agents: { list: [] },
        bindings: [],
      },
    });
    expect(mutateConfigFile).not.toHaveBeenCalled();
    expect(await pathExists(path.join(tempRoot, "workspace-feishu-ou_sender"))).toBe(false);
    expect(await pathExists(path.join(tempRoot, "agent-feishu-ou_sender"))).toBe(false);
  });

  it("persists a sender agent and direct binding when config writes are allowed", async () => {
    const { runtime, mutateConfigFile } = createRuntime();

    const result = await maybeCreateDynamicAgent({
      cfg: {
        agents: { list: [] },
        bindings: [],
      } as OpenClawConfig,
      runtime,
      senderOpenId: "ou_sender",
      dynamicCfg: createDynamicConfig(),
      configWritesAllowed: true,
      log: vi.fn(),
    });

    expect(result.created).toBe(true);
    expect(result.agentId).toBe("feishu-ou_sender");
    expect(mutateConfigFile).toHaveBeenCalledTimes(1);
    expect(mutateConfigFile).toHaveBeenCalledWith({
      base: "runtime",
      afterWrite: { mode: "auto" },
      mutate: expect.any(Function),
    });
    expect(result.updatedCfg).toEqual({
      agents: {
        list: [
          {
            id: "feishu-ou_sender",
            workspace: path.join(tempRoot, "workspace-feishu-ou_sender"),
            agentDir: path.join(tempRoot, "agent-feishu-ou_sender"),
          },
        ],
      },
      bindings: [
        {
          agentId: "feishu-ou_sender",
          match: {
            channel: "feishu",
            peer: { kind: "direct", id: "ou_sender" },
          },
        },
      ],
    });
    expect(await pathExists(path.join(tempRoot, "workspace-feishu-ou_sender"))).toBe(true);
    expect(await pathExists(path.join(tempRoot, "agent-feishu-ou_sender"))).toBe(true);
  });

  it("keeps the maxAgents limit before adding a missing binding", async () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "feishu-ou_sender",
            workspace: path.join(tempRoot, "existing-workspace"),
            agentDir: path.join(tempRoot, "existing-agent"),
          },
        ],
      },
      bindings: [],
    } as OpenClawConfig;
    const { runtime, mutateConfigFile } = createRuntime(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime,
      senderOpenId: "ou_sender",
      dynamicCfg: {
        ...createDynamicConfig(),
        maxAgents: 1,
      },
      configWritesAllowed: true,
      log: vi.fn(),
    });

    expect(result.created).toBe(false);
    expect(mutateConfigFile).not.toHaveBeenCalled();
  });

  it("preserves concurrent runtime config when creating from a stale request snapshot", async () => {
    const currentCfg = {
      agents: {
        list: [
          {
            id: "feishu-ou_existing",
            workspace: path.join(tempRoot, "existing-workspace"),
            agentDir: path.join(tempRoot, "existing-agent"),
          },
        ],
      },
      bindings: [
        {
          agentId: "feishu-ou_existing",
          match: {
            channel: "feishu",
            peer: { kind: "direct", id: "ou_existing" },
          },
        },
      ],
    } as OpenClawConfig;
    const { runtime, mutateConfigFile } = createRuntime(currentCfg);

    const result = await maybeCreateDynamicAgent({
      cfg: { agents: { list: [] }, bindings: [] } as OpenClawConfig,
      runtime,
      senderOpenId: "ou_sender",
      dynamicCfg: createDynamicConfig(),
      configWritesAllowed: true,
      log: vi.fn(),
    });

    expect(mutateConfigFile).toHaveBeenCalledWith({
      base: "runtime",
      afterWrite: { mode: "auto" },
      mutate: expect.any(Function),
    });
    expect(result.updatedCfg).toEqual({
      agents: {
        list: [
          ...currentCfg.agents!.list!,
          {
            id: "feishu-ou_sender",
            workspace: path.join(tempRoot, "workspace-feishu-ou_sender"),
            agentDir: path.join(tempRoot, "agent-feishu-ou_sender"),
          },
        ],
      },
      bindings: [
        ...currentCfg.bindings!,
        {
          agentId: "feishu-ou_sender",
          match: {
            channel: "feishu",
            peer: { kind: "direct", id: "ou_sender" },
          },
        },
      ],
    });
  });

  it("returns runtime current config when binding already exists", async () => {
    const currentCfg = {
      agents: {
        list: [
          {
            id: "feishu-ou_sender",
            workspace: path.join(tempRoot, "existing-workspace"),
            agentDir: path.join(tempRoot, "existing-agent"),
          },
        ],
      },
      bindings: [
        {
          agentId: "feishu-ou_sender",
          match: {
            channel: "feishu",
            peer: { kind: "direct", id: "ou_sender" },
          },
        },
      ],
    } as OpenClawConfig;
    const { runtime, mutateConfigFile } = createRuntime(currentCfg);

    const result = await maybeCreateDynamicAgent({
      cfg: {
        agents: { list: [] },
        bindings: [],
      } as OpenClawConfig,
      runtime,
      senderOpenId: "ou_sender",
      dynamicCfg: createDynamicConfig(),
      configWritesAllowed: true,
      log: vi.fn(),
    });

    expect(result.created).toBe(false);
    expect(result.updatedCfg).toStrictEqual(currentCfg);
    expect(mutateConfigFile).not.toHaveBeenCalled();
  });
});
