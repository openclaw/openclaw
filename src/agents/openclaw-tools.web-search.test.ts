import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SessionEntryCohortReader } from "../config/sessions/session-entry-read-runtime.types.js";
import {
  createOAuthAuthProfileStore,
  createWebSearchTestProvider,
} from "../test-utils/web-provider-runtime.test-helpers.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshotCore,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./auth-profiles/runtime-snapshots.js";
import * as authSource from "./auth-profiles/source-check.js";
import * as authStore from "./auth-profiles/store-runtime.js";
import { createCodeModeCatalogProjection } from "./code-mode-catalog.js";
import { createOpenClawToolsAsync } from "./openclaw-tools.js";
import { buildConfiguredAgentSystemPrompt } from "./system-prompt-config.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
} from "./tool-search-catalog.js";

// mock-isolation: Exercise real assembly without loading external plugins or credentials.
vi.mock("./openclaw-plugin-tools.js", () => ({ resolveOpenClawPluginToolsForOptions: () => [] }));
const { resolveProviders } = vi.hoisted(() => ({
  resolveProviders: vi.fn<() => ReturnType<typeof createWebSearchTestProvider>[]>(() => []),
}));
// mock-isolation: Only fixture providers participate in tool availability, not host credentials.
vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolveProviders,
  resolveRuntimeWebSearchProviders: resolveProviders,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  resolveProviders.mockReset().mockReturnValue([]);
  vi.spyOn(authStore, "ensureAuthProfileStoreWithoutExternalProfilesAsync").mockImplementation(
    async (agentDir) =>
      getRuntimeAuthProfileStoreSnapshotCore(agentDir) ?? { version: 1, profiles: {} },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
});

describe("unconfigured web search tool surface", () => {
  it.each([
    { label: "unconfigured", config: {}, expected: false, fact: false },
    {
      label: "configured",
      config: { tools: { web: { search: { provider: "brave" } } } },
      expected: true,
      fact: true,
    },
    {
      label: "explicit key-free",
      config: { tools: { web: { search: { provider: "duckduckgo" } } } },
      expected: true,
      fact: true,
    },
    {
      label: "disabled",
      config: { tools: { web: { search: { enabled: false } } } },
      expected: false,
      fact: undefined,
    },
  ])("prepares $label search in the async runtime factory", async ({ config, expected, fact }) => {
    const onWebSearchConfiguration = vi.fn();
    const tools = await createOpenClawToolsAsync({
      config,
      disableMessageTool: true,
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
      onWebSearchConfiguration,
    });
    expect(tools.some((tool) => tool.name === "web_search")).toBe(expected);
    if (fact === undefined) {
      expect(onWebSearchConfiguration).not.toHaveBeenCalled();
    } else {
      expect(onWebSearchConfiguration).toHaveBeenCalledExactlyOnceWith(fact);
    }
  });

  it.each([
    { prepared: true, source: false, provider: "test-search-auth", configured: true },
    { prepared: true, source: true, provider: "unrelated-provider", configured: false },
    { prepared: true, source: true, provider: "test-search-auth", configured: true },
    { prepared: true, source: undefined, provider: "test-search-auth", configured: true },
    { prepared: false, source: undefined, provider: "test-search-auth", configured: false },
    {
      prepared: false,
      source: undefined,
      provider: "test-search-auth",
      configured: false,
      selectedReader: true,
    },
  ])(
    "uses prepared=$prepared and source=$source for $provider during async construction (selectedReader=$selectedReader)",
    async ({ prepared, source: authProfileStoreSource, provider, configured, selectedReader }) => {
      const agentDir = tempDirs.make("openclaw-search-source-");
      const reader: SessionEntryCohortReader | undefined = selectedReader
        ? {
            database: { agentId: "main", path: agentDir, env: {} },
            sessionKey: "agent:main:test",
            logicalAgentId: "main",
            storePaths: [agentDir],
            assertCurrent: () => {},
            withRead: async () => {
              throw new Error("The auth owner is isolated by the source probe");
            },
          }
        : undefined;
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir,
          store: createOAuthAuthProfileStore({
            provider,
            profileId: `${provider}:test`,
            access: "test-access",
            refresh: "test-refresh",
          }),
        },
      ]);
      if (!prepared) {
        clearRuntimeAuthProfileStoreSnapshots();
      }
      resolveProviders.mockReturnValue([
        {
          ...createWebSearchTestProvider({
            pluginId: "test-search",
            id: "test-search",
            authProviderId: "test-search-auth",
            credentialPath: "plugins.entries.test-search.config.webSearch.apiKey",
          }),
          envVars: [],
        },
      ]);
      using sourceProbe = vi
        .spyOn(authSource, "hasAnyAuthProfileStoreSourceAsync")
        .mockResolvedValue(false);
      const onWebSearchConfiguration = vi.fn();
      const tools = await createOpenClawToolsAsync(
        {
          config: {},
          agentDir,
          authProfileStoreSource,
          disableMessageTool: true,
          disablePluginTools: true,
          wrapBeforeToolCallHook: false,
          onWebSearchConfiguration,
        },
        { reader },
      );
      // Prepared credentials are authoritative; source hints cannot override them.
      expect(tools.some((tool) => tool.name === "web_search")).toBe(configured);
      expect(onWebSearchConfiguration).toHaveBeenCalledExactlyOnceWith(configured);
      expect(
        authStore.ensureAuthProfileStoreWithoutExternalProfilesAsync,
      ).toHaveBeenCalledExactlyOnceWith(agentDir, { allowKeychainPrompt: false });
      expect(sourceProbe).not.toHaveBeenCalled();
    },
  );

  it.each(["full", "minimal"] as const)(
    "gives concise missing-setup context in %s prompts without a callable",
    (promptMode) => {
      const render = (webSearchUnconfigured: boolean, capabilityToolNames: string[] = []) =>
        buildConfiguredAgentSystemPrompt({
          config: {},
          workspaceDir: "/workspace",
          tools: [],
          capabilityToolNames,
          webSearchUnconfigured,
          promptMode,
        });
      const prompt = render(true);
      expect(prompt).toContain("Web search is supported but not configured.");
      expect(prompt).toContain("openclaw configure --section web");
      expect(prompt).toContain("Settings → Ask OpenClaw");
      expect(prompt).not.toContain("- web_search:");
      expect(render(false)).not.toContain("Web search is supported but not configured.");
      expect(render(true, ["web_search"])).not.toContain(
        "Web search is supported but not configured.",
      );
    },
  );

  it("excludes unconfigured search from initial tools, discovery, and Code Mode", () => {
    const tools = createOpenClawCodingTools({
      config: {},
      workspaceDir: "/tmp/openclaw-web-search-test",
      disableMessageTool: true,
      wrapBeforeToolCallHook: false,
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    });
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({ catalogRef, tools });
    const entries = catalogRef.current?.entries ?? [];
    expect.soft(tools.map((tool) => tool.name)).not.toContain("web_search");
    expect.soft(entries.map((entry) => entry.name)).not.toContain("web_search");
    expect(createCodeModeCatalogProjection(entries).byCallableName.has("web_search")).toBe(false);
    expect(tools.map((tool) => tool.name)).toContain("web_fetch");
  });
});
