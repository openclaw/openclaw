// A scheduled run's toolsAllow is an authority boundary: keeping the session's tools listed
// must refuse exactly the calls the allowlist refused when it removed those tools.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { getPluginToolMeta, setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { isAgentToolExecutionAvailable } from "../../agent-tool-availability.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";

// One MCP-backed plugin tool the allowlist does not name.
vi.mock("../../openclaw-plugin-tools.js", async (importOriginal) => {
  const pluginTools = () => {
    const tool = createStubTool("world__calendar_list");
    setPluginToolMeta(tool, {
      pluginId: "bundle-mcp",
      optional: false,
      mcp: {
        serverName: "world",
        safeServerName: "world",
        toolName: "calendar_list",
        operation: "tool",
      },
    });
    return [tool];
  };
  return {
    ...(await importOriginal<typeof import("../../openclaw-plugin-tools.js")>()),
    resolveOpenClawPluginToolsForOptions: pluginTools,
    resolveOpenClawPluginToolsForOptionsAsync: async () => pluginTools(),
  };
});

const config: OpenClawConfig = {
  agents: { entries: { main: {} } },
  tools: {
    profile: "coding",
    alsoAllow: ["world__calendar_list"],
    codeMode: false,
    toolSearch: { enabled: true, mode: "tools" },
  },
};
const sessionKey = "agent:main:telegram:direct:owner";
// Names, a group, a glob, and `message`, which the allowlist adds over the coding profile.
const toolsAllow = ["read", "group:web", "sessions_*", "message"];

async function prepareTools(overrides: Partial<EmbeddedRunAttemptInternalParams>) {
  await using resources = new AsyncDisposableStack();
  const runId = overrides.runId ?? "run";
  const admission = prepareSystemAgentRunAdmission(config, runId, "main", "test");
  resources.defer(() => admission.close());
  const attempt = {
    config,
    runId,
    sessionId: "scheduled-tools-allow",
    sessionKey,
    messageProvider: "telegram",
    messageTo: "telegram:owner",
    provider: "openai",
    modelId: "gpt-5.4",
    model: makeProviderModelFixture({
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    }),
    authProfileStore: { version: 1, profiles: {} },
    admittedRunContext: await admission.admit("embedded"),
    ...overrides,
  } as EmbeddedRunAttemptInternalParams;
  const result = await prepareEmbeddedAttemptToolBase({
    attempt,
    agentDir: "/tmp/openclaw-scheduled-tools-allow-agent",
    setup: createAttemptSetupFixture({ sandboxSessionKey: sessionKey }),
    markCoreToolStage: () => {},
    onYield: async () => {},
    runAbortController: new AbortController(),
    runTrace: { traceId: "1234567890abcdef1234567890abcdef" },
    skillUsagePaths: [],
    skillsSnapshot: undefined,
    codeModeSkills: [],
    toolSearchCatalogExecutor: async () => ({ content: [], details: {} }),
  });
  resources.defer(() => result.toolSurfaceRuntime.cleanup());
  resources.defer(() => result.releaseTools("test-complete"));
  const tools = result.toolsRaw;
  const catalog = await prepareEmbeddedAttemptToolCatalog({
    attempt,
    setup: createAttemptSetupFixture({ sandboxSessionKey: sessionKey }),
    preparedToolBase: result,
    bundleTools: { clientTools: undefined, uncompactedEffectiveTools: tools },
    abortSignal: result.toolAbortSignal,
    executeCodeModeTool: async () => ({ content: [], details: {} }),
  });
  return {
    emptyAllowlistError: catalog.emptyExplicitToolAllowlistError?.message,
    listed: tools.map((tool) => tool.name).toSorted(),
    callable: tools
      .filter(isAgentToolExecutionAvailable)
      .map((tool) => tool.name)
      .toSorted(),
    tools,
  };
}

const scheduled = {
  runId: "scheduled",
  trigger: "cron",
  toolsAllow,
  senderIsOwner: false,
} as const;

beforeEach(() => {
  setRuntimeConfigSnapshot(config);
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram" }),
          actions: { describeMessageTool: () => ({ actions: ["send"] }) },
        },
      },
    ]),
  );
});
afterEach(() => clearRuntimeConfigSnapshot());

// Recorded on the merge base, where the allowlist removed every other tool from the list.
const callableOnBase = [
  "dispatch_action",
  "message",
  "read",
  "sessions_create",
  "sessions_history",
  "sessions_list",
  "sessions_search",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "tool_describe",
  "tool_search",
  "web_fetch",
];

it("allows exactly the calls a scheduled toolsAllow allowed before", async () => {
  expect((await prepareTools(scheduled)).callable).toEqual(callableOnBase);
});

it("keeps the session's tools listed on a scheduled run and refuses the rest visibly", async () => {
  const run = await prepareTools(scheduled);
  const user = await prepareTools({ runId: "user", trigger: "user", senderIsOwner: true });
  // progress_card registration reads the allowlist itself; it stays unlisted here.
  expect(run.listed).toEqual(user.listed.filter((name) => name !== "progress_card"));
  const exec = run.tools.find((tool) => tool.name === "exec")!;
  const refused = await exec.execute("scheduled-exec", { command: "true" });
  expect(refused.details).toMatchObject({ gated: true });
  expect(JSON.stringify(refused.content)).toContain("exec is outside the tools this run allows");
  // A refused MCP tool keeps its provenance, so the catalog still treats it as MCP.
  const mcp = run.tools.find((tool) => tool.name === "world__calendar_list")!;
  expect(getPluginToolMeta(mcp)?.mcp?.serverName).toBe("world");
});

it("still fails a scheduled run whose allowlist matches no tool", async () => {
  const run = await prepareTools({ ...scheduled, toolsAllow: ["query_db"] });
  expect(run.emptyAllowlistError).toContain("No callable tools remain");
  expect(run.emptyAllowlistError).toContain("runtime toolsAllow: query_db");
});
