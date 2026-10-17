import fs from "node:fs/promises";
import os from "node:os";
import "./dynamic-tool-build.test-support.js";
import path from "node:path";
import type { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import type { EmbeddedRunAttemptParamsV3 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldEnableCodexAppServerNativeToolSurface } from "./dynamic-tool-build.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { prepareTestNativeExecutionPolicy } from "./native-execution-policy.test-support.js";

const {
  bindProductionCodexHostCapabilities,
  buildDynamicToolsForTest,
  cleanupDynamicToolBuildFixture,
  createCodexRuntimePlanFixture,
  createParams: createBaseParams,
  createRuntimeDynamicTool,
  hoisted,
} = await import("./dynamic-tool-build.test-support.js");

type ToolOptions = NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>;

function createParams(sessionFile: string, workspaceDir: string): EmbeddedRunAttemptParams {
  return {
    ...createBaseParams(sessionFile, workspaceDir),
    disableTools: false,
    runtimePlan: createCodexRuntimePlanFixture(),
  };
}

describe("Codex app-server dynamic tool search policy", () => {
  let tempDir: string;

  beforeEach(async () => {
    setRuntimeConfigSnapshot({});
    hoisted.loadNodeExecAvailability.mockResolvedValue({
      cacheKey: "eligible",
      isAvailable: () => true,
    });
    hoisted.normalizeAgentRuntimeTools.mockClear();
    hoisted.prepareWebSearchToolPolicy.mockClear();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-search-tools-"));
  });

  afterEach(async () => {
    await cleanupDynamicToolBuildFixture(tempDir, []);
    clearRuntimeConfigSnapshot();
  });

  it.each(["active", "aborted during preparation", "closed before publication"])(
    "publishes prepared search policy only while the builder attempt is %s",
    async (lifetime) => {
      const params = createParams(path.join(tempDir, "session.jsonl"), tempDir);
      const abort = new AbortController();
      params.abortSignal = abort.signal;
      const closers: Array<() => void> = [];
      await bindProductionCodexHostCapabilities(params, closers);
      const host = params.hostCapabilities;
      const prepare = host.prepareWebSearchToolPolicy!;
      const entered = createDeferred<void>();
      const resume = createDeferred<void>();
      params.hostCapabilities = {
        ...host,
        createToolSurfaceAsync: async () => [createRuntimeDynamicTool("message")],
        async prepareWebSearchToolPolicy(options) {
          const policy = await prepare(options);
          entered.resolve();
          await resume.promise;
          return policy;
        },
      };
      const persistent = vi.fn();
      const allowed = vi.fn();
      const build = buildDynamicToolsForTest(params, tempDir, {
        onPersistentWebSearchPolicyResolved: persistent,
        onWebSearchPolicyResolved: allowed,
      });
      try {
        await entered.promise;
        if (lifetime === "aborted during preparation") {
          abort.abort(new Error("attempt aborted during preparation"));
        } else if (lifetime === "closed before publication") {
          closers.forEach((close) => close());
        }
        resume.resolve();
        if (lifetime === "active") {
          expect((await build).map((tool) => tool.name)).toEqual(["message"]);
          expect(persistent).toHaveBeenCalledExactlyOnceWith(true);
          expect(allowed).toHaveBeenCalledExactlyOnceWith(true);
        } else {
          await expect(build).rejects.toThrow(
            lifetime === "aborted during preparation"
              ? "attempt aborted during preparation"
              : "no longer active",
          );
          expect(persistent).not.toHaveBeenCalled();
          expect(allowed).not.toHaveBeenCalled();
        }
      } finally {
        resume.resolve();
        closers.forEach((close) => close());
      }
    },
  );

  it.each<{
    name: string;
    config?: EmbeddedRunAttemptParams["config"];
    toolsAllow?: string[];
    senderId?: string;
    excludes?: string[];
    source: string[];
    exposed: string[];
    persistent: boolean;
    allowed: boolean;
    fetchAllowlist?: string[];
    nativeProviderWebSearchSupport?: "unsupported";
    skipsPolicyLookup?: boolean;
  }>([
    {
      name: "domain-restricted hosted search",
      config: { tools: { web: { search: { openaiCodex: { allowedDomains: ["example.com"] } } } } },
      source: ["web_search", "web_fetch", "message"],
      exposed: ["web_fetch", "message"],
      persistent: true,
      allowed: true,
      fetchAllowlist: ["example.com", "*.example.com"],
    },
    {
      name: "a managed provider despite native domains",
      config: {
        tools: {
          web: { search: { provider: "brave", openaiCodex: { allowedDomains: ["example.com"] } } },
        },
      },
      source: ["web_search", "web_fetch"],
      exposed: ["web_search", "web_fetch"],
      persistent: true,
      allowed: true,
    },
    {
      name: "an empty native domain allowlist",
      config: { tools: { web: { search: { openaiCodex: { allowedDomains: [] } } } } },
      source: ["web_search", "web_fetch"],
      exposed: ["web_fetch"],
      persistent: true,
      allowed: true,
    },
    {
      name: "runtime denial of domain-restricted search",
      config: { tools: { web: { search: { openaiCodex: { allowedDomains: ["example.com"] } } } } },
      toolsAllow: ["web_fetch"],
      source: ["web_search", "web_fetch"],
      exposed: ["web_fetch"],
      persistent: true,
      allowed: false,
    },
    {
      name: "effective policy denial despite a runtime cap",
      config: { tools: { deny: ["web_search"] } },
      toolsAllow: ["message"],
      source: ["message"],
      exposed: ["message"],
      persistent: false,
      allowed: false,
    },
    {
      name: "hosted search without a configured managed provider",
      source: ["message"],
      exposed: ["message"],
      persistent: true,
      allowed: true,
    },
    {
      name: "profile denial without a managed provider",
      config: { tools: { profile: "minimal" } },
      source: ["message"],
      exposed: ["message"],
      persistent: false,
      allowed: false,
    },
    {
      name: "plugin exclusion without a managed provider",
      excludes: ["web_search"],
      source: ["message"],
      exposed: ["message"],
      persistent: false,
      allowed: false,
    },
    {
      name: "runtime-only denial without a managed provider",
      toolsAllow: ["message"],
      source: ["message"],
      exposed: ["message"],
      persistent: true,
      allowed: false,
    },
    {
      name: "a native provider without hosted search or a managed provider",
      nativeProviderWebSearchSupport: "unsupported",
      source: ["message"],
      exposed: ["message"],
      persistent: false,
      allowed: false,
    },
    {
      name: "runtime-only denial",
      toolsAllow: ["message"],
      source: ["web_search", "message"],
      exposed: ["message"],
      persistent: true,
      allowed: false,
      skipsPolicyLookup: true,
    },
    {
      name: "transient sender denial",
      senderId: "restricted-sender",
      config: { tools: { toolsBySender: { "id:restricted-sender": { deny: ["web_search"] } } } },
      source: ["message"],
      exposed: ["message"],
      persistent: true,
      allowed: false,
    },
    {
      name: "a native provider without hosted search",
      nativeProviderWebSearchSupport: "unsupported",
      source: ["web_search", "message"],
      exposed: ["web_search", "message"],
      persistent: true,
      allowed: true,
    },
  ])("projects search tools and persistent policy for $name", async (testCase) => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.config = testCase.config;
    params.toolsAllow = testCase.toolsAllow;
    params.senderId = testCase.senderId;
    let receivedOptions: ToolOptions | undefined;
    setCodexTestToolFactory(params, (options) => {
      receivedOptions = options;
      return testCase.source.map(createRuntimeDynamicTool);
    });
    const persistent = vi.fn();
    const allowed = vi.fn();

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      nativeToolSurfaceEnabled: shouldEnableCodexAppServerNativeToolSurface(params, undefined, {
        nativeExecutionPolicy: await prepareTestNativeExecutionPolicy(params),
      }),
      nativeProviderWebSearchSupport: testCase.nativeProviderWebSearchSupport,
      pluginConfig: { codexDynamicToolsExclude: testCase.excludes },
      onPersistentWebSearchPolicyResolved: persistent,
      onWebSearchPolicyResolved: allowed,
    });

    expect(tools.map((tool) => tool.name)).toEqual(testCase.exposed);
    expect(receivedOptions?.webFetchHostnameAllowlistRef?.value).toEqual(testCase.fetchAllowlist);
    expect(persistent).toHaveBeenCalledExactlyOnceWith(testCase.persistent);
    expect(allowed).toHaveBeenCalledExactlyOnceWith(testCase.allowed);
    if (testCase.skipsPolicyLookup) {
      expect(hoisted.prepareWebSearchToolPolicy).not.toHaveBeenCalled();
    }
  });

  it.each([true, false])(
    "limits memory flush tools while persistent search enabled=%s",
    async (searchEnabled) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      const factory = vi.fn((_options: Parameters<typeof createOpenClawCodingTools>[0]) =>
        (searchEnabled
          ? ["read", "write", "exec", "process", "apply_patch", "message", "web_search"]
          : ["read", "write", "web_search"]
        ).map(createRuntimeDynamicTool),
      );
      setCodexTestToolFactory(params, factory);
      params.trigger = "memory";
      params.memoryFlushWritePath = "memory/2026-05-22.md";
      if (!searchEnabled) {
        params.config = { tools: { web: { search: { enabled: false } } } };
      }
      const persistent = vi.fn();
      const allowed = vi.fn();
      const sandbox = { enabled: true, backendId: "docker" } as never;
      const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(
        params,
        sandbox,
        {
          nativeExecutionPolicy: await prepareTestNativeExecutionPolicy(params, {
            sandbox,
          }),
        },
      );
      const tools = await buildDynamicToolsForTest(params, workspaceDir, {
        ...(searchEnabled ? { sandbox, nativeToolSurfaceEnabled } : {}),
        onPersistentWebSearchPolicyResolved: persistent,
        onWebSearchPolicyResolved: allowed,
      });
      expect(nativeToolSurfaceEnabled).toBe(false);
      expect(factory).toHaveBeenCalledOnce();
      expect(factory.mock.calls[0]?.[0]).toMatchObject({
        trigger: "memory",
        memoryFlushWritePath: "memory/2026-05-22.md",
      });
      expect(tools.map((tool) => tool.name)).toEqual(["read", "write"]);
      expect(persistent).toHaveBeenCalledExactlyOnceWith(searchEnabled);
      expect(allowed).toHaveBeenCalledExactlyOnceWith(false);
    },
  );
});
