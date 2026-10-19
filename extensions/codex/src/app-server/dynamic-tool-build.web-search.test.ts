import "./dynamic-tool-build.test-support.js";
import path from "node:path";
import type { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import type { EmbeddedRunAttemptParamsV2 as RunParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { shouldEnableCodexAppServerNativeToolSurface } from "./dynamic-tool-build.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { prepareTestNativeExecutionPolicy } from "./native-execution-policy.test-support.js";

const {
  buildDynamicToolsForTest,
  cleanupDynamicToolBuildFixture,
  createCodexRuntimePlanFixture,
  createParams,
  createRuntimeDynamicTool,
  hoisted,
  setupDynamicToolBuildFixture,
} = await import("./dynamic-tool-build.test-support.js");

type ToolOptions = Parameters<typeof createOpenClawCodingTools>[0];
type SearchCase = Partial<Pick<RunParams, "config" | "toolsAllow" | "senderId">> & {
  name: string;
  excludes?: string[];
  source: string[];
  exposed: string[];
  persistent: boolean;
  allowed: boolean;
  fetchAllowlist?: string[];
  nativeProviderWebSearchSupport?: "unsupported";
  skipsPolicyLookup?: boolean;
};

let tempDir: string;
let workspaceDir: string;
let params: RunParams;

beforeEach(async () => {
  tempDir = await setupDynamicToolBuildFixture();
  workspaceDir = path.join(tempDir, "workspace");
  params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir, {
    disableTools: false,
    runtimePlan: createCodexRuntimePlanFixture(),
  });
});
afterEach(() => cleanupDynamicToolBuildFixture(tempDir, []));

async function nativeSurface(
  sandbox?: Parameters<typeof shouldEnableCodexAppServerNativeToolSurface>[1],
) {
  return shouldEnableCodexAppServerNativeToolSurface(params, sandbox, {
    nativeExecutionPolicy: await prepareTestNativeExecutionPolicy(params, { sandbox }),
  });
}

const denied = { persistent: false, allowed: false };
const webTools = ["web_search", "web_fetch"];
const domainConfig = {
  tools: { web: { search: { openaiCodex: { allowedDomains: ["example.com"] } } } },
};
function searchCase(name: string, overrides: Partial<SearchCase> = {}): SearchCase {
  return {
    name,
    source: ["message"],
    exposed: ["message"],
    persistent: true,
    allowed: true,
    ...overrides,
  };
}
it.each([
  searchCase("domain-restricted hosted search", {
    config: domainConfig,
    source: [...webTools, "message"],
    exposed: ["web_fetch", "message"],
    fetchAllowlist: ["example.com", "*.example.com"],
  }),
  searchCase("a managed provider despite native domains", {
    config: {
      tools: { web: { search: { provider: "brave", ...domainConfig.tools.web.search } } },
    },
    source: webTools,
    exposed: webTools,
  }),
  searchCase("an empty native domain allowlist", {
    config: { tools: { web: { search: { openaiCodex: { allowedDomains: [] } } } } },
    source: webTools,
    exposed: ["web_fetch"],
  }),
  searchCase("runtime denial of domain-restricted search", {
    config: domainConfig,
    toolsAllow: ["web_fetch"],
    source: webTools,
    exposed: ["web_fetch"],
    allowed: false,
  }),
  searchCase("effective policy denial despite a runtime cap", {
    config: { tools: { deny: ["web_search"] } },
    toolsAllow: ["message"],
    ...denied,
  }),
  searchCase("hosted search without a configured managed provider"),
  searchCase("profile denial without a managed provider", {
    config: { tools: { profile: "minimal" } },
    ...denied,
  }),
  searchCase("plugin exclusion without a managed provider", {
    excludes: ["web_search"],
    ...denied,
  }),
  searchCase("runtime-only denial without a managed provider", {
    toolsAllow: ["message"],
    allowed: false,
  }),
  searchCase("a native provider without hosted search or a managed provider", {
    nativeProviderWebSearchSupport: "unsupported",
    ...denied,
  }),
  searchCase("runtime-only denial", {
    toolsAllow: ["message"],
    source: ["web_search", "message"],
    allowed: false,
    skipsPolicyLookup: true,
  }),
  searchCase("transient sender denial", {
    senderId: "restricted-sender",
    config: { tools: { toolsBySender: { "id:restricted-sender": { deny: ["web_search"] } } } },
    allowed: false,
  }),
  searchCase("a native provider without hosted search", {
    nativeProviderWebSearchSupport: "unsupported",
    source: ["web_search", "message"],
    exposed: ["web_search", "message"],
  }),
])("projects search tools and persistent policy for $name", async (testCase) => {
  params.config = testCase.config;
  params.toolsAllow = testCase.toolsAllow;
  params.senderId = testCase.senderId;
  const factory = vi.fn((_options: ToolOptions) => testCase.source.map(createRuntimeDynamicTool));
  setCodexTestToolFactory(params, factory);
  const persistent = vi.fn();
  const allowed = vi.fn();

  const tools = await buildDynamicToolsForTest(params, workspaceDir, {
    nativeToolSurfaceEnabled: await nativeSurface(),
    nativeProviderWebSearchSupport: testCase.nativeProviderWebSearchSupport,
    pluginConfig: { codexDynamicToolsExclude: testCase.excludes },
    onPersistentWebSearchPolicyResolved: persistent,
    onWebSearchPolicyResolved: allowed,
  });

  expect(tools.map((tool) => tool.name)).toEqual(testCase.exposed);
  const options = factory.mock.calls[0]?.[0];
  expect(options?.webFetchHostnameAllowlistRef?.value).toEqual(testCase.fetchAllowlist);
  expect(persistent).toHaveBeenCalledExactlyOnceWith(testCase.persistent);
  expect(allowed).toHaveBeenCalledExactlyOnceWith(testCase.allowed);
  if (testCase.skipsPolicyLookup) {
    expect(hoisted.resolveWebSearchToolPolicy).not.toHaveBeenCalled();
  }
});

it.each([true, false])(
  "limits memory flush tools while persistent search enabled=%s",
  async (searchEnabled) => {
    const factory = vi.fn((_options: ToolOptions) =>
      ["read", "write", "exec", "process", "apply_patch", "message", "web_search"].map(
        createRuntimeDynamicTool,
      ),
    );
    setCodexTestToolFactory(params, factory);
    params.trigger = "memory";
    params.memoryFlushWritePath = "memory/2026-05-22.md";
    params.config = searchEnabled ? undefined : { tools: { web: { search: { enabled: false } } } };
    const persistent = vi.fn();
    const allowed = vi.fn();
    const sandbox = { enabled: true, backendId: "docker" } as never;
    const nativeToolSurfaceEnabled = await nativeSurface(sandbox);
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
