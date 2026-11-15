import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

async function scenario(
  cfg = createConfig(),
  options: {
    request?: OpenClawConfig;
    mutation?: OpenClawConfig;
    persisted?: OpenClawConfig;
    call?: Parameters<typeof createAgent>[2];
  } = {},
) {
  let runtimeCfg = structuredClone(cfg);
  const commitConfig = vi.fn();
  const mutateConfigFile = vi.fn(
    async (params: {
      mutate: (draft: OpenClawConfig, context: { snapshot: never; previousHash: null }) => unknown;
    }) => {
      const draft = structuredClone(options.mutation ?? runtimeCfg);
      const result = await params.mutate(draft, { snapshot: {} as never, previousHash: null });
      runtimeCfg = draft;
      commitConfig();
      return { nextConfig: options.persisted ?? runtimeCfg, result };
    },
  );
  const runtime = {
    config: { mutateConfigFile, current: () => runtimeCfg },
  } as unknown as PluginRuntime;
  return {
    runtime,
    commitConfig,
    mutateConfigFile,
    result: await createAgent(options.request ?? cfg, runtime, options.call),
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

const existingAgent = () => ({
  workspace: path.join(tempRoot, "existing-workspace"),
  agentDir: path.join(tempRoot, "existing-agent"),
});

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

it.each([
  ["config writes disabled", 0, 0],
  ["ingress denied", 0, 1],
  ["ingress revoked inside lock", 1, 2],
  ["non-peer route added inside lock", 1, 1],
  ["dynamic agent limit reached inside lock", 1, 1],
] as const)("creates no state with %s", async (policy, mutations, admissions) => {
  const cfg = createConfig(
    policy === "config writes disabled"
      ? { configWrites: false }
      : policy === "dynamic agent limit reached inside lock"
        ? { dynamicAgentCreation: { ...createDynamicConfig(), maxAgents: 1 } }
        : {},
  );
  const mutation: OpenClawConfig = {
    ...cfg,
    ...(policy === "non-peer route added inside lock"
      ? { bindings: [{ agentId: "main", match: { channel: "feishu", accountId: "default" } }] }
      : policy === "dynamic agent limit reached inside lock"
        ? { agents: createCanonicalAgentRoster({ "feishu-ou_existing": {}, unrelated: {} }) }
        : {}),
  };
  const canCreateForConfig = vi
    .fn<(cfg: OpenClawConfig) => Promise<boolean>>()
    .mockResolvedValueOnce(policy !== "ingress denied")
    .mockResolvedValue(policy !== "ingress revoked inside lock");
  const { result, commitConfig, mutateConfigFile } = await scenario(cfg, {
    mutation,
    call: { canCreateForConfig },
  });
  expect(result).toEqual({ created: false, updatedCfg: mutation });
  expect(canCreateForConfig).toHaveBeenCalledTimes(admissions);
  expect(mutateConfigFile).toHaveBeenCalledTimes(mutations);
  expect(commitConfig).not.toHaveBeenCalled();
  await expectNoDirectories();
});

it("scopes bindings to the normalized account id", async () => {
  const { result } = await scenario(createConfig(), { call: { accountId: "Ops Team" } });
  const agentId = result.updatedCfg.bindings?.[0]?.agentId ?? "";

  expect(result.created).toBe(true);
  expect(agentId).toMatch(/^feishu-ops-team-[a-f0-9]{32}$/);
  expect(result.updatedCfg.agents?.entries).toHaveProperty(agentId);
  expect(result.updatedCfg.bindings).toEqual([binding(agentId, "ops-team")]);
});

it("keeps named-account dynamic agent ids bounded and sender-unique", async () => {
  const accountId = "a".repeat(64);
  const { result: first, runtime } = await scenario(createConfig(), {
    call: { accountId, senderOpenId: "ou_sender_one_with_a_shared_long_prefix" },
  });
  const second = await createAgent(first.updatedCfg, runtime, {
    accountId,
    senderOpenId: "ou_sender_two_with_a_shared_long_prefix",
  });
  const firstAgentId = first.updatedCfg.bindings?.[0]?.agentId ?? "";
  const secondAgentId = second.updatedCfg.bindings?.at(-1)?.agentId ?? "";

  expect([firstAgentId.length, secondAgentId.length]).toEqual([52, 52]);
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
  const { result, mutateConfigFile } = await scenario(cfg, {
    request: {
      ...createConfig({ dynamicAgentCreation: { ...createDynamicConfig(), maxAgents: 2 } }),
      agents: cfg.agents,
    },
  });

  expect(result.created).toBe(false);
  expect(mutateConfigFile).not.toHaveBeenCalled();
});

it("adds only the missing binding for an agent found in the cloned mutation roster", async () => {
  const mutationCfg = createConfig({}, { "feishu-ou_sender": existingAgent() });
  const { result, commitConfig } = await scenario(createConfig(), { mutation: mutationCfg });

  expect(result.created).toBe(true);
  expect(commitConfig).toHaveBeenCalledTimes(1);
  expect(result.updatedCfg.agents).toEqual(mutationCfg.agents);
  expect(result.updatedCfg.bindings).toEqual([binding("feishu-ou_sender", "default")]);
  await expectNoDirectories();
});

it("preserves concurrent runtime config when creating from a stale request snapshot", async () => {
  const currentCfg = {
    ...createConfig({}, { "feishu-ou_existing": existingAgent() }),
    bindings: [binding("feishu-ou_existing", undefined, "ou_existing")],
  } as OpenClawConfig;
  const { result } = await scenario(currentCfg, {
    request: { agents: createCanonicalAgentRoster(), bindings: [] },
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
  const { result } = await scenario(currentCfg, {
    persisted: { channels: { feishu: { appSecret: { source: "env", id: "FEISHU_APP_SECRET" } } } },
  });

  expect(result.updatedCfg.channels?.feishu?.appSecret).toBe("resolved-secret");
  expect(result.updatedCfg.bindings).toHaveLength(1);
});

it("returns runtime current binding even when config writes are disabled", async () => {
  const currentCfg = {
    channels: { feishu: { configWrites: false } },
    agents: createCanonicalAgentRoster({ "feishu-ou_sender": existingAgent() }),
    bindings: [binding("feishu-ou_sender")],
  } as OpenClawConfig;
  const { result, mutateConfigFile } = await scenario(currentCfg, {
    request: { agents: createCanonicalAgentRoster(), bindings: [] },
  });

  expect(result.created).toBe(false);
  expect(result.updatedCfg).toStrictEqual(currentCfg);
  expect(mutateConfigFile).not.toHaveBeenCalled();
});
