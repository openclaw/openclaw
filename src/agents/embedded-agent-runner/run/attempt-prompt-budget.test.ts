// Byte budgets for what the embedded runtime sends, built by the production attempt pipeline:
// tool base, bundle tools, catalog compaction, then the system prompt.
import { afterEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { normalizeSessionDeliveryState } from "../../../utils/delivery-context.shared.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { PROMPT_BUDGET_BYTES } from "../../system-prompt-manifest.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { prepareEmbeddedAttemptSystemPrompt } from "./attempt-system-prompt-prepare.js";
import { createEmptyPromptBootstrap } from "./attempt-system-prompt.test-support.js";
import { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";

// mock-isolation: Prompt assembly consumes the prepared provider handle; discovery belongs to attempt setup.
vi.mock("../../../plugins/providers.runtime-core.js", () => {
  const reject = () => {
    throw new Error("Prompt budget fixture unexpectedly discovered provider runtime");
  };
  return {
    createProviderRegistryResolver: () => ({
      isPluginProvidersLoadInFlight: reject,
      resolvePluginProvidersCore: reject,
    }),
  };
});
// Budgets cover core output; installed plugins, MCP servers and paired nodes vary by host.
vi.mock("../../openclaw-plugin-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../openclaw-plugin-tools.js")>()),
  resolveOpenClawPluginToolsForOptions: () => [],
  resolveOpenClawPluginToolsForOptionsAsync: async () => [],
}));
vi.mock("../../agent-bundle-mcp-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agent-bundle-mcp-tools.js")>()),
  acquireSessionMcpRuntime: async () => undefined,
}));
vi.mock("../../computer-use-node-capabilities.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../computer-use-node-capabilities.js")>()),
  loadPairedComputerUseAvailabilityForSurface: async () => undefined,
}));

afterEach(() => {
  clearRuntimeConfigSnapshot();
  setActivePluginRegistry(createTestRegistry([]));
});

const config: OpenClawConfig = { agents: { entries: { main: {} } } };
const skillsPrompt = [
  "<available_skills>",
  "- github: Use the gh CLI for issues and pull requests.",
  "- weather: Current weather and forecasts.",
  "</available_skills>",
].join("\n");

async function prepareRoute(route: {
  sessionKey: string;
  attempt: Partial<EmbeddedRunAttemptInternalParams>;
  contextFiles: Array<{ path: string; content: string }>;
  /** A fresh install still runs BOOTSTRAP.md; a configured agent recorded setup complete. */
  bootstrapMode: "full" | "none";
}) {
  setRuntimeConfigSnapshot(config);
  await using resources = new AsyncDisposableStack();
  const admission = prepareSystemAgentRunAdmission(config, "run-budget", "main", "test");
  resources.defer(() => admission.close());
  const attempt = {
    config,
    runId: "run-budget",
    sessionId: "budget",
    sessionKey: route.sessionKey,
    trigger: "user",
    senderIsOwner: true,
    provider: "openai",
    modelId: "gpt-5.4",
    model: makeProviderModelFixture({
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    }),
    workspaceDir: "/workspace",
    permissionMode: "full",
    promptMode: "full",
    authProfileStore: { version: 1, profiles: {} },
    admittedRunContext: await admission.admit("embedded"),
    ...route.attempt,
  } as EmbeddedRunAttemptInternalParams;
  const setup = createAttemptSetupFixture({
    effectiveCwd: "/workspace",
    effectiveWorkspace: "/workspace",
    resolvedWorkspace: "/workspace",
    sessionPermissionRoot: "/workspace",
    sandboxSessionKey: route.sessionKey,
    getProviderRuntimeHandle: () => ({
      provider: attempt.provider,
      modelId: attempt.modelId,
      workspaceDir: "/workspace",
      prepared: true,
    }),
  });
  const toolBase = await prepareEmbeddedAttemptToolBase({
    attempt,
    agentDir: "/agent",
    setup,
    markCoreToolStage: () => {},
    onYield: async () => {},
    runAbortController: new AbortController(),
    runTrace: { traceId: "1234567890abcdef1234567890abcdef" },
    skillUsagePaths: [],
    skillsSnapshot: undefined,
    codeModeSkills: [],
    toolSearchCatalogExecutor: async () => ({ content: [], details: {} }),
  });
  resources.defer(() => toolBase.toolSurfaceRuntime.cleanup());
  resources.defer(() => toolBase.releaseTools("test-complete"));
  const bundle = await prepareEmbeddedAttemptBundleTools({
    agentDir: "/agent",
    attempt,
    setup,
    isRawModelRun: false,
    preparedToolBase: toolBase,
  });
  const catalog = await prepareEmbeddedAttemptToolCatalog({
    attempt,
    setup,
    preparedToolBase: toolBase,
    bundleTools: bundle,
    abortSignal: toolBase.toolAbortSignal ?? new AbortController().signal,
    executeCodeModeTool: async () => ({ content: [], details: {} }),
  });
  const prepared = await prepareEmbeddedAttemptSystemPrompt({
    attempt,
    activeContextEngine: undefined,
    bootstrap: {
      ...createEmptyPromptBootstrap(),
      contextFiles: route.contextFiles,
      bootstrapMode: route.bootstrapMode,
      bootstrapCompleted: route.bootstrapMode === "none",
    },
    // The checkout path appears in the prompt; pin it so every host measures the same bytes.
    referencePaths: { docsPath: "/repo/docs", sourcePath: "/repo" },
    capabilityToolNames: catalog.toolSearchRunPlan.capabilityToolNames,
    effectiveTools: catalog.effectiveTools,
    setup,
    isRawModelRun: false,
    modelToolsEnabled: toolBase.toolsEnabled,
    skillsPrompt,
    codeModeActive: toolBase.codeModeControlsEnabledForRun,
    webSearchUnconfigured: () => toolBase.webSearchUnconfigured,
    toolSearchCatalogRef: toolBase.toolSearchCatalogRef,
    toolSearchDirectoryEnabled:
      toolBase.toolSearchControlsEnabledForRun && catalog.toolSearch.catalogRegistered,
    deferredToolsDirectlyCallable: catalog.deferredDirectoryToolsCallable,
    toolSearchRuntimeConfig: toolBase.toolSearchRuntimeConfig,
  });
  const definitions = catalog.effectiveTools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  return {
    promptBytes: Buffer.byteLength(prepared.systemPromptText, "utf8"),
    toolBytes: Buffer.byteLength(JSON.stringify(definitions), "utf8"),
  };
}

it("keeps a fresh Gateway WebChat turn within its prompt and tool budgets", async () => {
  const { promptBytes, toolBytes } = await prepareRoute({
    sessionKey: "agent:main:dashboard:budget",
    attempt: {
      messageProvider: "webchat",
      messageChannel: "webchat",
      sourceReplyDeliveryMode: "automatic",
      sessionPromptDelivery: normalizeSessionDeliveryState({
        context: { channel: "webchat" },
        origin: { provider: "webchat", surface: "webchat", chatType: "direct" },
      }),
    },
    bootstrapMode: "full",
    contextFiles: [
      { path: "/workspace/AGENTS.md", content: "[MISSING] Expected at: /workspace/AGENTS.md" },
    ],
  });
  expect.soft(promptBytes).toBeLessThanOrEqual(PROMPT_BUDGET_BYTES.gatewayWebChatSystemPrompt);
  expect.soft(toolBytes).toBeLessThanOrEqual(PROMPT_BUDGET_BYTES.gatewayWebChatTools);
});

it("keeps a configured Telegram agent within its prompt and tool budgets", async () => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram" }),
          actions: { describeMessageTool: () => ({ actions: ["send", "react"] }) },
        },
      },
    ]),
  );
  const { promptBytes, toolBytes } = await prepareRoute({
    sessionKey: "agent:main:telegram:direct:10001",
    attempt: {
      messageProvider: "telegram",
      messageChannel: "telegram",
      messageTo: "telegram:10001",
      chatType: "direct",
      sourceReplyDeliveryMode: "automatic",
      sessionPromptDelivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", to: "telegram:10001" },
        origin: { provider: "telegram", surface: "telegram", chatType: "direct" },
      }),
    },
    bootstrapMode: "none",
    contextFiles: [
      { path: "/workspace/AGENTS.md", content: "# AGENTS.md\n\nRead SOUL.md first." },
      { path: "/workspace/SOUL.md", content: "# SOUL.md\n\nYou are Pip." },
      { path: "/workspace/USER.md", content: "# USER.md\n\nName: Sam." },
      { path: "/workspace/MEMORY.md", content: "# MEMORY.md\n\n- Sam ships on Fridays." },
    ],
  });
  expect.soft(promptBytes).toBeLessThanOrEqual(PROMPT_BUDGET_BYTES.configuredAgentSystemPrompt);
  expect.soft(toolBytes).toBeLessThanOrEqual(PROMPT_BUDGET_BYTES.configuredAgentTools);
});
