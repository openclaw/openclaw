import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import { maybeCreateDynamicAgent } from "./dynamic-agent.js";
import type { FeishuConfig } from "./types.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-agent-"));
});

afterEach(async () => {
  await fs.promises.rm(tempRoot, { recursive: true, force: true });
});

function createRuntime(
  currentCfg: OpenClawConfig,
  persistedCfg?: OpenClawConfig,
  mutationCfg?: OpenClawConfig,
) {
  let runtimeCfg = structuredClone(currentCfg);
  const commitConfig = vi.fn();
  const mutateConfigFile = vi.fn(
    async (params: {
      mutate: (draft: OpenClawConfig, context: { snapshot: never; previousHash: null }) => unknown;
    }) => {
      const draft = structuredClone(mutationCfg ?? runtimeCfg);
      const result = await params.mutate(draft, { snapshot: {} as never, previousHash: null });
      runtimeCfg = draft;
      commitConfig();
      return { nextConfig: persistedCfg ?? runtimeCfg, result };
    },
  );
  const config = { mutateConfigFile, current: vi.fn(() => runtimeCfg) };
  return {
    runtime: { config } as unknown as PluginRuntime,
    commitConfig,
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

function createCanonicalAgentRoster(
  entries: NonNullable<OpenClawConfig["agents"]>["entries"] = {},
): OpenClawConfig["agents"] {
  return {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "main" } },
    entries: { main: {}, ...entries },
  };
}

function createConfig(
  feishu: Partial<FeishuConfig> = {},
  entries: NonNullable<OpenClawConfig["agents"]>["entries"] = {},
): OpenClawConfig {
  return {
    channels: { feishu: { dynamicAgentCreation: createDynamicConfig(), ...feishu } },
    agents: createCanonicalAgentRoster(entries),
    bindings: [],
  };
}

function existingAgent() {
  return {
    workspace: path.join(tempRoot, "existing-workspace"),
    agentDir: path.join(tempRoot, "existing-agent"),
  };
}

function binding(agentId: string, accountId?: string, sender = "ou_sender") {
  return {
    agentId,
    match: {
      channel: "feishu",
      ...(accountId ? { accountId } : {}),
      peer: { kind: "direct" as const, id: sender },
    },
  };
}

async function expectNoDirectories() {
  for (const kind of ["workspace", "agent"]) {
    await expect(
      fs.promises.stat(path.join(tempRoot, `${kind}-feishu-ou_sender`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }
}

function createAgent(
  cfg: OpenClawConfig,
  runtime: PluginRuntime,
  overrides: Partial<Omit<Parameters<typeof maybeCreateDynamicAgent>[0], "cfg" | "runtime">> = {},
) {
  return maybeCreateDynamicAgent({
    cfg,
    runtime,
    accountId: "default",
    senderOpenId: "ou_sender",
    canCreateForConfig: async () => true,
    log: vi.fn(),
    ...overrides,
  });
}

describe("maybeCreateDynamicAgent", () => {
  it.each(["config writes disabled", "ingress denied"])(
    "creates no state with %s",
    async (policy) => {
      const cfg = createConfig(policy === "config writes disabled" ? { configWrites: false } : {});
      const { runtime, mutateConfigFile } = createRuntime(cfg);
      const result = await createAgent(cfg, runtime, {
        canCreateForConfig: async () => policy !== "ingress denied",
      });

      expect(result).toEqual({ created: false, updatedCfg: cfg });
      expect(mutateConfigFile).not.toHaveBeenCalled();
      await expectNoDirectories();
    },
  );

  it("rechecks current ingress inside the config mutation lock", async () => {
    const cfg = createConfig();
    const { runtime, commitConfig, mutateConfigFile } = createRuntime(cfg);
    const canCreateForConfig = vi
      .fn<(cfg: OpenClawConfig) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const result = await createAgent(cfg, runtime, { canCreateForConfig });

    expect(result.created).toBe(false);
    expect(canCreateForConfig).toHaveBeenCalledTimes(2);
    expect(mutateConfigFile).toHaveBeenCalledTimes(1);
    expect(commitConfig).not.toHaveBeenCalled();
    expect(result.updatedCfg.agents?.entries).toEqual({ main: {} });
    expect(result.updatedCfg.bindings).toEqual([]);
    await expectNoDirectories();
  });

  it.each(["non-peer route", "dynamic agent limit"])(
    "honors %s added before the mutation lock",
    async (change) => {
      const cfg = createConfig(
        change === "dynamic agent limit"
          ? { dynamicAgentCreation: { ...createDynamicConfig(), maxAgents: 1 } }
          : {},
      );
      const mutationCfg: OpenClawConfig = {
        ...cfg,
        ...(change === "non-peer route"
          ? {
              bindings: [
                {
                  agentId: "main",
                  match: { channel: "feishu", accountId: "default" },
                },
              ],
            }
          : { agents: createCanonicalAgentRoster({ "feishu-ou_existing": {}, unrelated: {} }) }),
      };
      const { runtime, commitConfig, mutateConfigFile } = createRuntime(
        cfg,
        undefined,
        mutationCfg,
      );

      const result = await createAgent(cfg, runtime);

      expect(result).toEqual({ created: false, updatedCfg: mutationCfg });
      expect(mutateConfigFile).toHaveBeenCalledTimes(1);
      expect(commitConfig).not.toHaveBeenCalled();
      await expectNoDirectories();
    },
  );

  it("scopes bindings to the normalized account id", async () => {
    const cfg = createConfig();
    const { runtime } = createRuntime(cfg);

    const result = await createAgent(cfg, runtime, { accountId: "Ops Team" });
    const agentId = result.updatedCfg.bindings?.[0]?.agentId ?? "";

    expect(result.created).toBe(true);
    expect(agentId).toMatch(/^feishu-ops-team-[a-f0-9]{32}$/);
    expect(result.updatedCfg.agents?.entries).toHaveProperty(agentId);
    expect(result.updatedCfg.bindings).toEqual([binding(agentId, "ops-team")]);
  });

  it("keeps named-account dynamic agent ids bounded and sender-unique", async () => {
    const accountId = "a".repeat(64);
    const cfg = createConfig();
    const { runtime } = createRuntime(cfg);

    const first = await createAgent(cfg, runtime, {
      accountId,
      senderOpenId: "ou_sender_one_with_a_shared_long_prefix",
    });
    const second = await createAgent(first.updatedCfg, runtime, {
      accountId,
      senderOpenId: "ou_sender_two_with_a_shared_long_prefix",
    });
    const firstAgentId = first.updatedCfg.bindings?.[0]?.agentId ?? "";
    const secondAgentId = second.updatedCfg.bindings?.at(-1)?.agentId ?? "";

    expect(firstAgentId).toHaveLength(52);
    expect(secondAgentId).toHaveLength(52);
    expect(firstAgentId).not.toBe(secondAgentId);
    expect(Object.keys(second.updatedCfg.agents?.entries ?? {})).toEqual([
      "main",
      firstAgentId,
      secondAgentId,
    ]);
  });

  it("uses the current maxAgents limit instead of stale request policy", async () => {
    const cfg = createConfig(
      { dynamicAgentCreation: { ...createDynamicConfig(), maxAgents: 1 } },
      { "feishu-ou_existing": existingAgent() },
    );
    const { runtime, mutateConfigFile } = createRuntime(cfg);

    const result = await createAgent(
      {
        ...createConfig({ dynamicAgentCreation: { ...createDynamicConfig(), maxAgents: 2 } }),
        agents: cfg.agents,
      },
      runtime,
    );

    expect(result.created).toBe(false);
    expect(mutateConfigFile).not.toHaveBeenCalled();
  });

  it("adds only the missing binding for an agent found in the cloned mutation roster", async () => {
    const cfg = createConfig();
    const mutationCfg = createConfig({}, { "feishu-ou_sender": existingAgent() });
    const { runtime, commitConfig } = createRuntime(cfg, undefined, mutationCfg);

    const result = await createAgent(cfg, runtime);

    expect(result.created).toBe(true);
    expect(commitConfig).toHaveBeenCalledTimes(1);
    expect(result.updatedCfg.agents).toEqual(mutationCfg.agents);
    expect(result.updatedCfg.agents).not.toHaveProperty("list");
    expect(result.updatedCfg.bindings).toEqual([binding("feishu-ou_sender", "default")]);
    await expectNoDirectories();
  });

  it("preserves concurrent runtime config when creating from a stale request snapshot", async () => {
    const currentCfg = {
      ...createConfig({}, { "feishu-ou_existing": existingAgent() }),
      bindings: [binding("feishu-ou_existing", undefined, "ou_existing")],
    } as OpenClawConfig;
    const { runtime, mutateConfigFile } = createRuntime(currentCfg);

    const result = await createAgent(
      { agents: createCanonicalAgentRoster(), bindings: [] },
      runtime,
    );

    expect(mutateConfigFile).toHaveBeenCalledWith({
      base: "runtime",
      afterWrite: { mode: "auto" },
      mutate: expect.any(Function),
    });
    expect(result.updatedCfg.agents?.entries).toEqual({
      ...currentCfg.agents?.entries,
      "feishu-ou_sender": {
        workspace: path.join(tempRoot, "workspace-feishu-ou_sender"),
        agentDir: path.join(tempRoot, "agent-feishu-ou_sender"),
      },
    });
    expect(result.updatedCfg.agents).not.toHaveProperty("list");
    expect(result.updatedCfg.bindings).toEqual([
      ...currentCfg.bindings!,
      binding("feishu-ou_sender", "default"),
    ]);
  });

  it("returns refreshed runtime config instead of the persisted source config", async () => {
    const currentCfg = createConfig({ appSecret: "resolved-secret" });
    const appSecret = { source: "env", id: "FEISHU_APP_SECRET" };
    const persistedCfg: OpenClawConfig = { channels: { feishu: { appSecret } } };
    const { runtime } = createRuntime(currentCfg, persistedCfg);

    const result = await createAgent(currentCfg, runtime);

    expect(result.updatedCfg.channels?.feishu?.appSecret).toBe("resolved-secret");
    expect(result.updatedCfg.bindings).toHaveLength(1);
  });

  it("returns runtime current binding even when config writes are disabled", async () => {
    const currentCfg = {
      channels: { feishu: { configWrites: false } },
      agents: createCanonicalAgentRoster({ "feishu-ou_sender": existingAgent() }),
      bindings: [binding("feishu-ou_sender")],
    } as OpenClawConfig;
    const { runtime, mutateConfigFile } = createRuntime(currentCfg);

    const result = await createAgent(
      { agents: createCanonicalAgentRoster(), bindings: [] },
      runtime,
    );

    expect(result.created).toBe(false);
    expect(result.updatedCfg).toStrictEqual(currentCfg);
    expect(mutateConfigFile).not.toHaveBeenCalled();
  });
});
