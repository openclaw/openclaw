// Embedded route: the agent profile follows the config size class, then the route-matched
// total parameter count, then falls back to the base profile.
import { afterEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";

// No bundle MCP servers in this harness.
vi.mock("../../agent-bundle-mcp-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agent-bundle-mcp-tools.js")>()),
  acquireSessionMcpRuntime: async () => undefined,
}));

const config: OpenClawConfig = {
  agents: { defaults: { agentProfileId: "auto" }, entries: { main: {} } },
};

async function selectProfile(modelExtras: { parameterCount?: number; modelSizeClass?: string }) {
  setRuntimeConfigSnapshot(config);
  await using resources = new AsyncDisposableStack();
  const admission = prepareSystemAgentRunAdmission(config, "run", "main", "test");
  resources.defer(() => admission.close());
  const attempt = {
    config,
    runId: "run",
    sessionId: "size-class",
    sessionKey: "agent:main:size-class",
    provider: "llama-cpp",
    modelId: "test-model",
    model: {
      ...makeProviderModelFixture({
        id: "test-model",
        provider: "llama-cpp",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:1241/v1",
      }),
      ...modelExtras,
    },
    authProfileStore: { version: 1, profiles: {} },
    admittedRunContext: await admission.admit("embedded"),
  } as unknown as EmbeddedRunAttemptInternalParams;
  const result = await prepareEmbeddedAttemptToolBase({
    attempt,
    agentDir: "/tmp/openclaw-size-class-agent",
    setup: createAttemptSetupFixture({ sandboxSessionKey: attempt.sessionKey }),
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
  return {
    id: result.agentProfile.profile.id,
    selectionSource: result.agentProfile.selectionSource,
  };
}

afterEach(() => clearRuntimeConfigSnapshot());

it.each([
  {
    label: "8B total parameters",
    model: { parameterCount: 8_190_735_360 },
    expected: { id: "openclaw/small", selectionSource: "model-size" },
  },
  {
    label: "34.66B total parameters",
    model: { parameterCount: 34_660_610_688 },
    expected: { id: "openclaw/base", selectionSource: "model-size" },
  },
  {
    label: "no parameter count",
    model: {},
    expected: { id: "openclaw/base", selectionSource: "fallback" },
  },
  {
    label: "explicit config class over the count",
    model: { parameterCount: 8_190_735_360, modelSizeClass: "medium" },
    expected: { id: "openclaw/base", selectionSource: "model-size" },
  },
])("selects the embedded agent profile from $label", async ({ model, expected }) => {
  expect(await selectProfile(model)).toEqual(expected);
});
