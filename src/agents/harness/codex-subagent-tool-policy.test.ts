import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata.test-support.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { isToolAllowedByPolicies } from "../tool-policy-match.js";
import { preparePluginHarnessToolPolicies } from "./execution-environment.js";

const codex = await loadBundledPluginFacade<{
  CODEX_NATIVE_TOOL_REQUIREMENTS: readonly string[];
  CODEX_TOOL_POLICY_SAFE_DENY_NAMES: readonly string[];
  buildCodexRuntimeThreadConfigForRun: (
    params: {
      modelId: string;
      pluginHarnessToolPolicyRestricted: boolean;
      pluginHarnessToolPolicySafeDeniedTools?: readonly string[];
    },
    config: Record<string, unknown> | undefined,
    options: { nativeCodeModeEnabled: boolean; hostSystemAgentActive: boolean },
  ) => Record<string, unknown>;
}>({ pluginId: "codex", artifactBasename: "test-api.js" });
const tempDirs = useSessionStoreTempDirs(afterAll, "codex-child-policy-");
const prepare = (
  params: Omit<Parameters<typeof preparePluginHarnessToolPolicies>[0], "provider" | "modelId">,
  safeDenyToolNames: readonly string[] = codex.CODEX_TOOL_POLICY_SAFE_DENY_NAMES,
) =>
  preparePluginHarnessToolPolicies(
    { agentId: "main", provider: "openai", modelId: "test-model", ...params },
    safeDenyToolNames,
    codex.CODEX_NATIVE_TOOL_REQUIREMENTS,
  );
const threadConfig = (policy: {
  toolPolicyRestricted: boolean;
  safeDeniedToolNames?: readonly string[];
}) =>
  codex.buildCodexRuntimeThreadConfigForRun(
    {
      modelId: "test-model",
      pluginHarnessToolPolicyRestricted: policy.toolPolicyRestricted,
      pluginHarnessToolPolicySafeDeniedTools: policy.safeDeniedToolNames,
    },
    { "features.apps": true },
    { nativeCodeModeEnabled: true, hostSystemAgentActive: false },
  );

describe("Codex subagent native tool policy", () => {
  it.each([
    { name: "exact intent denial", tools: { deny: ["intent"] }, restricted: false },
    { name: "agent intent denial", tools: { deny: [" INTENT "] }, agent: true, restricted: false },
    {
      name: "LanceDB denial",
      tools: { deny: ["memory_store"] },
      plugin: "memory-lancedb",
      tool: "memory_store",
      restricted: false,
    },
    {
      name: "wiki denial",
      tools: { deny: ["wiki_search"] },
      plugin: "memory-wiki",
      tool: "wiki_search",
      restricted: false,
    },
    {
      name: "unrelated audited plugin denial",
      tools: { deny: ["fixture_lookup"] },
      plugin: "fixture",
      tool: "fixture_lookup",
      audit: true,
      restricted: false,
    },
    {
      name: "unaudited plugin denial",
      tools: { deny: ["fixture_lookup"] },
      plugin: "fixture",
      tool: "fixture_lookup",
      restricted: true,
    },
    { name: "mixed unsafe denial", tools: { deny: ["intent", "nodes"] }, restricted: true },
    { name: "wildcard denial", tools: { deny: ["intent*"] }, restricted: true },
    { name: "finite allowlist", tools: { allow: ["message"], deny: ["intent"] }, restricted: true },
    {
      name: "missing plugin declaration",
      tools: { deny: ["intent"] },
      declared: false,
      restricted: true,
    },
  ])(
    "preserves hosted apps only for an audited $name",
    async ({ tools, restricted, declared, plugin, tool, audit, agent }) => {
      const toolName = tool ?? "intent";
      const config: OpenClawConfig = agent
        ? { agents: { entries: { main: { tools } } } }
        : { tools };
      const workspaceDir = process.cwd();
      const manifestRegistry = makeRegistry(
        declared === false
          ? []
          : [
              {
                id: plugin ?? "memory-core",
                origin: "bundled",
                channels: [],
                contracts: { tools: [toolName] },
              },
            ],
      );
      setCurrentPluginMetadataSnapshot(
        createPluginMetadataSnapshot({ config, manifestRegistry, workspaceDir }),
        { config, workspaceDir },
      );
      try {
        const policy = await prepare(
          {
            config,
            workspaceDir,
            sessionKey: "agent:main:main",
            sessionId: "intent-policy",
          },
          [...codex.CODEX_TOOL_POLICY_SAFE_DENY_NAMES, ...(audit ? [toolName] : [])],
        );
        expect(isToolAllowedByPolicies(toolName, policy.runtimePolicies)).toBe(false);
        expect(policy.toolPolicyRestricted).toBe(restricted);
        expect(threadConfig(policy)["features.apps"]).toBe(!restricted);
        if (!restricted) {
          expect(policy.safeDeniedToolNames).toEqual([toolName]);
        }
      } finally {
        setCurrentPluginMetadataSnapshot(undefined);
      }
    },
  );

  it("preserves native tools for OpenClaw admin/status-only denial", async () => {
    const deny = ["agents_list", "openclaw", "session_status", "progress_card"];
    const policy = await prepare({
      sessionKey: "agent:main:main",
      sessionId: "policy-root",
      config: { tools: { deny } },
    });
    for (const tool of deny) {
      expect(isToolAllowedByPolicies(tool, policy.runtimePolicies), tool).toBe(false);
    }
    expect(policy.toolPolicyRestricted).toBe(false);
    const config = threadConfig(policy);
    expect(config["features.code_mode"]).toBe(true);
    expect(config["agents.enabled"]).toBeUndefined();
  });

  it("restricts the whole native surface for an unaudited denial", async () => {
    const policy = await prepare({
      sessionKey: "agent:main:main",
      sessionId: "policy-unaudited",
      config: { tools: { deny: ["nodes"] } },
    });
    expect(policy.toolPolicyRestricted).toBe(true);
    expect(threadConfig(policy)["features.code_mode"]).toBe(false);
  });

  it.each([
    { name: "hidden child", key: "subagent", config: {} },
    { name: "unstamped dashboard child", key: "dashboard", config: {} },
    {
      name: "leaf at the depth cap",
      key: "subagent",
      config: { agents: { defaults: { subagents: { maxSpawnDepth: 1 } } } },
    },
  ] satisfies Array<{
    name: string;
    key?: string;
    config: OpenClawConfig;
  }>)("preserves the effective policy for $name", async (testCase) => {
    const sessionKey = `agent:main:${testCase.key ?? "subagent"}:policy-child`;
    const store = path.join(tempDirs.make(), "sessions.json");
    await replaceSessionEntry(
      { sessionKey, storePath: store },
      {
        sessionId: "policy-child",
        updatedAt: 1,
        spawnDepth: 1,
        spawnedBy: "agent:main:main",
      },
    );
    const policy = await prepare({
      sessionKey,
      sessionId: "policy-child",
      config: { ...testCase.config, session: { store } },
    });
    // Direct OpenClaw denial and native restriction must agree on the denied effect.
    for (const tool of ["gateway", "openclaw", "sessions_send", "conversations_turn"]) {
      expect(isToolAllowedByPolicies(tool, policy.runtimePolicies), tool).toBe(false);
    }
    // Session and conversation denies keep the native shell and file surface,
    // and are enforced by disabling native delegation (the native tools that
    // can address other threads).
    expect(policy.toolPolicyRestricted).toBe(false);
    const config = threadConfig(policy);
    expect(config["features.code_mode"]).toBe(true);
    for (const key of ["agents.enabled", "features.multi_agent", "features.multi_agent_v2"]) {
      expect(config[key], key).toBe(false);
    }
  });

  it.each([
    { name: "an unrestricted parent", inheritedToolDeny: undefined, restricted: false },
    { name: "a restricted parent", inheritedToolDeny: ["exec"], restricted: true },
  ])("keeps native tools for a visible spawn from $name", async (testCase) => {
    const sessionKey = "agent:main:dashboard:visible-child";
    const store = path.join(tempDirs.make(), "sessions.json");
    await replaceSessionEntry(
      { sessionKey, storePath: store },
      {
        sessionId: "visible-child",
        updatedAt: 1,
        createdVia: "spawn",
        spawnDepth: 1,
        spawnedBy: "agent:main:main",
        inheritedToolPolicyVersion: 1,
        inheritedToolDeny: testCase.inheritedToolDeny,
      },
    );
    const policy = await prepare({
      sessionKey,
      sessionId: "visible-child",
      // Depth 1 is the leaf at this cap; visible spawns still skip the default denies.
      config: { agents: { defaults: { subagents: { maxSpawnDepth: 1 } } }, session: { store } },
    });
    for (const tool of ["gateway", "sessions_send", "conversations_turn", "sessions_spawn"]) {
      expect(isToolAllowedByPolicies(tool, policy.runtimePolicies), tool).toBe(true);
    }
    expect(isToolAllowedByPolicies("exec", policy.runtimePolicies)).toBe(!testCase.restricted);
    expect(policy.toolPolicyRestricted).toBe(testCase.restricted);
    expect(threadConfig(policy)["features.code_mode"]).toBe(!testCase.restricted);
  });
});
