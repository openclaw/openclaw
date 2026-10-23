import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
const tokens = { access: "test-access", refresh: "test-refresh" };
const unconfigured = "Web search is supported but not configured.";
async function expectSearch(
  expected: boolean,
  fact: boolean | undefined,
  options: Parameters<typeof createOpenClawToolsAsync>[0],
  context?: Parameters<typeof createOpenClawToolsAsync>[1],
) {
  const onWebSearchConfiguration = vi.fn();
  const tools = await createOpenClawToolsAsync(
    {
      disableMessageTool: true,
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
      ...options,
      onWebSearchConfiguration,
    },
    context,
  );
  expect(tools.some((tool) => tool.name === "web_search")).toBe(expected);
  expect(onWebSearchConfiguration.mock.calls).toEqual(fact === undefined ? [] : [[fact]]);
}
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

it.each([
  ["unconfigured", undefined, false, false],
  ["configured", { provider: "brave" }, true, true],
  ["explicit key-free", { provider: "duckduckgo" }, true, true],
  ["disabled", { enabled: false }, false, undefined],
] as const)(
  "prepares %s search in the async runtime factory",
  async (_label, search, expected, fact) => {
    await expectSearch(expected, fact, {
      config: search ? { tools: { web: { search } } } : {},
    });
  },
);

it.each([
  [true, false, "test-search-auth", true, false],
  [true, true, "unrelated-provider", false, false],
  [true, true, "test-search-auth", true, false],
  [true, undefined, "test-search-auth", true, false],
  [false, undefined, "test-search-auth", false, false],
  [false, undefined, "test-search-auth", false, true],
] as const)(
  "uses prepared=%s source=%s provider=%s configured=%s selectedReader=%s",
  async (prepared, authProfileStoreSource, provider, configured, selectedReader) => {
    const agentDir = tempDirs.make("openclaw-search-source-");
    const reader: SessionEntryCohortReader | undefined = selectedReader
      ? {
          database: { agentId: "main", path: agentDir, env: {} },
          sessionKey: "agent:main:test",
          logicalAgentId: "main",
          storePaths: [agentDir],
          assertCurrent: () => {},
          readEntry: unexpectedRead,
          withRead: unexpectedRead,
        }
      : undefined;
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir,
        store: createOAuthAuthProfileStore({ provider, profileId: `${provider}:test`, ...tokens }),
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
    await expectSearch(
      configured,
      configured,
      {
        config: {},
        agentDir,
        authProfileStoreSource,
      },
      { reader },
    );
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
    expect(prompt).toContain(unconfigured);
    expect(prompt).toContain("openclaw configure --section web");
    expect(prompt).toContain("Settings → Ask OpenClaw");
    expect(prompt).not.toContain("- web_search:");
    expect(render(false)).not.toContain(unconfigured);
    expect(render(true, ["web_search"])).not.toContain(unconfigured);
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

async function unexpectedRead(): Promise<never> {
  throw new Error("The auth owner is isolated by the source probe");
}
