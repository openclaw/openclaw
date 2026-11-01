import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureSessionEntryCurrentCheckAsync } from "../../plugin-sdk/session-binding-runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { isToolAllowedByPolicies } from "../tool-policy-match.js";
import { preparePluginHarnessToolPolicies } from "./execution-environment.js";

const codex = await loadBundledPluginFacade<{
  CODEX_NATIVE_TOOL_REQUIREMENTS: readonly string[];
  CODEX_TOOL_POLICY_SAFE_DENY_NAMES: readonly string[];
  buildCodexRuntimeThreadConfigForRun: (
    params: { modelId: string; pluginHarnessToolPolicyRestricted: boolean },
    config: undefined,
    options: { nativeCodeModeEnabled: boolean; hostSystemAgentActive: boolean },
  ) => Record<string, unknown>;
}>({ pluginId: "codex", artifactBasename: "test-api.js" });
const tempDirs = useSessionStoreTempDirs(afterAll, "codex-child-policy-");
const prepare = (
  params: Omit<Parameters<typeof preparePluginHarnessToolPolicies>[0], "provider" | "modelId">,
) =>
  preparePluginHarnessToolPolicies(
    { agentId: "main", provider: "openai", modelId: "test-model", ...params },
    codex.CODEX_TOOL_POLICY_SAFE_DENY_NAMES,
    codex.CODEX_NATIVE_TOOL_REQUIREMENTS,
  );
const threadConfig = (pluginHarnessToolPolicyRestricted: boolean) =>
  codex.buildCodexRuntimeThreadConfigForRun(
    { modelId: "test-model", pluginHarnessToolPolicyRestricted },
    undefined,
    { nativeCodeModeEnabled: true, hostSystemAgentActive: false },
  );

describe("Codex subagent native tool policy", () => {
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
    const config = threadConfig(policy.toolPolicyRestricted);
    expect(config["features.code_mode"]).toBe(true);
    expect(config["agents.enabled"]).toBeUndefined();
  });

  it.each([
    { name: "hidden child", key: "subagent", config: {} },
    { name: "visible child", key: "dashboard", config: {} },
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
    const config = threadConfig(policy.toolPolicyRestricted);
    expect(config["features.code_mode"]).toBe(false);
    for (const key of ["agents.enabled", "features.multi_agent", "features.multi_agent_v2"]) {
      expect(config[key], key).toBe(false);
    }
  });

  it("keeps a scheduled run child's prepared requester facts current while the run row changes", async () => {
    const run = "agent:main:cron:nightly:run:r1";
    const child = "agent:main:subagent:run-child";
    const store = path.join(tempDirs.make(), "sessions.json");
    const write = (sessionKey: string, entry: Parameters<typeof replaceSessionEntry>[1]) =>
      replaceSessionEntry({ sessionKey, storePath: store }, entry);
    await write(run, { sessionId: "run-session", updatedAt: 1, agentHarnessId: "codex" });
    const childEntry = {
      sessionId: "run-child",
      updatedAt: 1,
      spawnDepth: 1,
      spawnedBy: run,
      inheritedToolPolicyVersion: 1 as const,
      inheritedToolPolicySource: "scheduled-run" as const,
      inheritedToolPolicyRunSessionKey: run,
    };
    await write(child, childEntry);
    const policy = await preparePluginHarnessToolPolicies(
      {
        agentId: "main",
        provider: "openai",
        modelId: "test-model",
        sessionKey: child,
        sessionId: "run-child",
        requesterOrigin: { sessionKey: run, scheduledRunSessionKey: run },
        config: { session: { store }, tools: { toolsBySender: { "*": { deny: ["read"] } } } },
      },
      codex.CODEX_TOOL_POLICY_SAFE_DENY_NAMES,
      codex.CODEX_NATIVE_TOOL_REQUIREMENTS,
      { provider: "openai", model: "test-model" },
    );
    const facts = policy.webSearchPolicy?.requesterFacts ?? [];
    expect(isToolAllowedByPolicies("read", policy.runtimePolicies)).toBe(true);
    expect(facts.map(({ query }) => query.sessionKey)).toEqual([child]);
    // The checks Codex retains for the turn and its tool calls.
    const sources = await Promise.all(
      facts.map(async ({ query, facts: recorded }) => {
        const source = await captureSessionEntryCurrentCheckAsync({
          ...query,
          fields: recorded?.map(({ field }) => field) ?? [],
          errorMessage: "requester policy changed",
        });
        expect(
          recorded?.every(({ field, value }) => isDeepStrictEqual(source.entry?.[field], value)),
        ).toBe(true);
        return source;
      }),
    );
    try {
      // Compaction rotates the run's session id; fallback and post-prompt sync rewrite it.
      await write(run, { sessionId: "run-compacted", updatedAt: 2, agentHarnessId: "pi" });
      for (const source of sources) {
        await expect(source.assertCurrent()).resolves.toBeUndefined();
      }
      await write(child, { ...childEntry, inheritedToolDeny: ["exec"] });
      await expect(sources[0]?.assertCurrent()).rejects.toThrow("requester policy changed");
    } finally {
      for (const source of sources) {
        source.release?.();
      }
    }
  });
});
