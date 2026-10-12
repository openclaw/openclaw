import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { getHoisted, resetEmbeddedAttemptHarness } from "./attempt-spawn-workspace.test-support.js";
import { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";

const hoisted = getHoisted();
beforeEach(() => resetEmbeddedAttemptHarness());
afterEach(() => vi.restoreAllMocks());

describe("prepared web search availability", () => {
  it.each([
    { name: "ordinary unconfigured", expected: true },
    { name: "configured", configured: true, expected: false },
    { name: "policy denied", deny: true, expected: false },
    { name: "globally disabled", disabled: true, expected: false },
    { name: "session disabled", sessionDisabled: true, expected: false },
    { name: "native OpenAI", native: true, expected: false, callable: true },
    { name: "native policy denied", native: true, deny: true, expected: false },
    { name: "native globally disabled", native: true, disabled: true, expected: false },
    { name: "native session disabled", native: true, sessionDisabled: true, expected: false },
    { name: "native runtime denied", native: true, runtimeDenied: true, expected: false },
    { name: "native execution denied", native: true, executionDenied: true, expected: false },
    { name: "native tools disabled", native: true, toolsDisabled: true, expected: false },
    { name: "custom endpoint", native: true, customEndpoint: true, expected: true },
  ])("keeps guidance and callable presence truthful for $name on rebuild", async (scenario) => {
    const config: OpenClawConfig = {
      tools: {
        codeMode: true,
        allow: ["web_search"],
        toolSearch: { enabled: false },
        ...(scenario.deny ? { deny: ["web_search"] } : {}),
        ...(scenario.disabled ? { web: { search: { enabled: false } } } : {}),
      },
    };
    const admission = prepareSystemAgentRunAdmission(config, "search-guidance", "main", "test");
    let result: Awaited<ReturnType<typeof prepareEmbeddedAttemptToolBase>> | undefined;
    try {
      hoisted.createOpenClawCodingToolsMock.mockImplementation((options) => {
        options?.onWebSearchConfiguration?.(scenario.configured === true);
        return [];
      });
      // SAFETY: This fixture invokes only tool preparation; transcript/model execution fields
      // are deliberately absent. Existing harness mocks own those unrelated collaborators.
      const attempt = {
        config,
        runId: "search-guidance",
        sessionId: "search-guidance",
        sessionKey: "agent:main:search-guidance",
        agentDir: "/tmp/search-guidance-agent",
        modelId: "test-model",
        provider: scenario.native ? "openai" : "anthropic",
        model: makeProviderModelFixture({
          id: "test-model",
          provider: scenario.native ? "openai" : "anthropic",
          api: scenario.native ? "openai-responses" : "anthropic-messages",
          baseUrl: scenario.customEndpoint
            ? "https://api.example.test/v1"
            : scenario.native
              ? "https://api.openai.com/v1"
              : "https://api.anthropic.com",
        }),
        authProfileStore: { version: 1, profiles: {} },
        admittedRunContext: await admission.admit("embedded"),
        toolOverrides: scenario.sessionDisabled ? { webSearch: false } : undefined,
        toolsAllow: scenario.runtimeDenied ? ["exec"] : ["web_search", "exec"],
        toolExecutionAllow: scenario.executionDenied ? ["read"] : undefined,
        disableTools: scenario.toolsDisabled,
      } as EmbeddedRunAttemptInternalParams;
      result = await prepareEmbeddedAttemptToolBase({
        attempt,
        agentDir: attempt.agentDir!,
        setup: createAttemptSetupFixture({ sandboxSessionKey: attempt.sessionKey! }),
        markCoreToolStage: () => {},
        onYield: async () => {},
        runAbortController: new AbortController(),
        runTrace: { traceId: "1234567890abcdef1234567890abcdef" },
        skillUsagePaths: [],
        skillsSnapshot: undefined,
        codeModeSkills: [],
        toolSearchCatalogExecutor: async () => ({ content: [], details: {} }),
      });
      expect(hoisted.createOpenClawCodingToolsMock).toHaveBeenCalledTimes(
        scenario.toolsDisabled ? 0 : 1,
      );
      expect(result.webSearchUnconfigured).toBe(scenario.expected);
      const catalog = await prepareEmbeddedAttemptToolCatalog({
        attempt,
        setup: createAttemptSetupFixture({ sandboxSessionKey: attempt.sessionKey! }),
        preparedToolBase: result,
        bundleTools: { clientTools: undefined, uncompactedEffectiveTools: result.toolsRaw },
        abortSignal: new AbortController().signal,
        executeCodeModeTool: async () => ({ content: [], details: {} }),
      });
      expect(catalog.toolSearch.catalogToolCount).toBe(0);
      expect(catalog.toolSearchRunPlan.hasCallableTools).toBe(scenario.callable === true);
      if (scenario.callable) {
        expect(catalog.emptyExplicitToolAllowlistError).toBeNull();
        expect(catalog.toolSearchRunPlan.liveAllowedToolNames.has("web_search")).toBe(false);
      }
      // A disabled factory does not report configuration. Reset must clear the previous fact,
      // rather than relying on a later callback to overwrite it.
      hoisted.createOpenClawCodingToolsMock.mockImplementation(() => []);
      attempt.toolOverrides = { webSearch: false };
      await result.refreshPermissionMode(null, () => {});
      expect(result.webSearchUnconfigured).toBe(false);
      catalog.refreshTools(() => {});
      expect(catalog.toolSearchRunPlan.hasCallableTools).toBe(false);
      expect(hoisted.createOpenClawCodingToolsMock).toHaveBeenCalledTimes(
        scenario.toolsDisabled ? 0 : 2,
      );
    } finally {
      await result?.releaseTools("test-complete");
      result?.toolSurfaceRuntime.cleanup();
      admission.close();
    }
  });
});
