import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { isToolAllowedByPolicies } from "../tool-policy-match.js";
import { resolvePluginHarnessToolPolicies } from "./execution-environment.js";

const codex = await loadBundledPluginFacade<{
  CODEX_NATIVE_TOOL_REQUIREMENTS: readonly string[];
  CODEX_TOOL_POLICY_SAFE_DENY_NAMES: readonly string[];
  buildCodexRuntimeThreadConfigForRun: (
    params: { modelId: string; pluginHarnessToolPolicyRestricted: boolean },
    config: undefined,
    options: { nativeCodeModeEnabled: boolean; hostSystemAgentActive: boolean },
  ) => Record<string, unknown>;
}>({ pluginId: "codex", artifactBasename: "test-api.js" });
const tempDirs = useAutoCleanupTempDirTracker(afterAll);

describe("Codex subagent native tool policy", () => {
  it("preserves native tools for OpenClaw admin/status-only denial", () => {
    const deny = ["agents_list", "openclaw", "session_status", "progress_card"];
    const policy = resolvePluginHarnessToolPolicies(
      {
        sessionKey: "agent:main:main",
        sessionId: "policy-root",
        agentId: "main",
        provider: "openai",
        modelId: "test-model",
        config: { tools: { deny } },
      },
      codex.CODEX_TOOL_POLICY_SAFE_DENY_NAMES,
      codex.CODEX_NATIVE_TOOL_REQUIREMENTS,
    );
    for (const tool of deny) {
      expect(isToolAllowedByPolicies(tool, policy.runtimePolicies), tool).toBe(false);
    }
    expect(policy.toolPolicyRestricted).toBe(false);
    const config = codex.buildCodexRuntimeThreadConfigForRun(
      { modelId: "test-model", pluginHarnessToolPolicyRestricted: policy.toolPolicyRestricted },
      undefined,
      { nativeCodeModeEnabled: true, hostSystemAgentActive: false },
    );
    expect(config["features.code_mode"]).toBe(true);
    expect(config["agents.enabled"]).toBeUndefined();
  });

  it.each([
    { name: "hidden child", key: "subagent", config: {}, restricted: true },
    { name: "visible child", key: "dashboard", config: {}, restricted: true },
    {
      name: "leaf at the depth cap",
      key: "subagent",
      config: { agents: { defaults: { subagents: { maxSpawnDepth: 1 } } } },
      restricted: true,
    },
    { name: "session send deny", config: { tools: { deny: ["sessions_send"] } }, restricted: true },
    {
      name: "inherited session send deny",
      config: {},
      inheritedToolDeny: ["sessions_send"],
      restricted: true,
    },
    { name: "exec deny", config: { tools: { deny: ["exec"] } }, restricted: true },
    { name: "unknown deny", config: { tools: { deny: ["unknown_tool"] } }, restricted: true },
    { name: "finite allowlist", config: { tools: { allow: ["read"] } }, restricted: true },
    { name: "inherited exec deny", config: {}, inheritedToolDeny: ["exec"], restricted: true },
  ] satisfies Array<{
    name: string;
    key?: string;
    config: OpenClawConfig;
    inheritedToolDeny?: string[];
    restricted: boolean;
  }>)("preserves the effective policy for $name", async (testCase) => {
    const sessionKey = `agent:main:${testCase.key ?? "subagent"}:policy-child`;
    const store = path.join(tempDirs.make("codex-child-policy-"), "sessions.json");
    await replaceSessionEntry(
      { sessionKey, storePath: store },
      {
        sessionId: "policy-child",
        updatedAt: 1,
        spawnDepth: 1,
        spawnedBy: "agent:main:main",
        inheritedToolDeny: testCase.inheritedToolDeny,
      },
    );
    const policy = resolvePluginHarnessToolPolicies(
      {
        sessionKey,
        sessionId: "policy-child",
        agentId: "main",
        provider: "openai",
        modelId: "test-model",
        config: { ...testCase.config, session: { store } },
      },
      codex.CODEX_TOOL_POLICY_SAFE_DENY_NAMES,
      codex.CODEX_NATIVE_TOOL_REQUIREMENTS,
    );
    // Direct OpenClaw denial and native restriction must agree on the denied effect.
    for (const tool of ["gateway", "openclaw", "sessions_send", "conversations_turn"]) {
      expect(isToolAllowedByPolicies(tool, policy.runtimePolicies), tool).toBe(false);
    }
    const config = codex.buildCodexRuntimeThreadConfigForRun(
      { modelId: "test-model", pluginHarnessToolPolicyRestricted: policy.toolPolicyRestricted },
      undefined,
      { nativeCodeModeEnabled: true, hostSystemAgentActive: false },
    );
    expect(config["features.code_mode"]).toBe(!testCase.restricted);
    for (const key of ["agents.enabled", "features.multi_agent", "features.multi_agent_v2"]) {
      expect(config[key], key).toBe(testCase.restricted ? false : undefined);
    }
  });
});
