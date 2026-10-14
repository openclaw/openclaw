import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { SessionWorkStartInvalidatedError } from "../../../config/sessions/work-start-error.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { wrapToolWithBeforeToolCallHook } from "../../agent-tools.before-tool-call.js";
import type { AnyAgentTool } from "../../agent-tools.types.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { getHoisted, resetEmbeddedAttemptHarness } from "./attempt-spawn-workspace.test-support.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";

const hoisted = getHoisted();
beforeEach(() => resetEmbeddedAttemptHarness());
afterEach(() => vi.restoreAllMocks());

describe("prepared missing-search guidance", () => {
  it.each(["retired source", "capture invalidated"] as const)(
    "retains attribution and aborts failed built-in and catalog tool preparation (%s)",
    async (outcome) => {
      const config: OpenClawConfig = { tools: { codeMode: false, toolSearch: { enabled: false } } };
      const admission = prepareSystemAgentRunAdmission(config, "attribution", "main", "test");
      const entered = createDeferred();
      const baseline = createDeferred();
      const runAbortController = new AbortController();
      const failure = new SessionWorkStartInvalidatedError("capture invalidated");
      const execute = vi.fn(async () => ({ content: [], details: {} }));
      let result: Awaited<ReturnType<typeof prepareEmbeddedAttemptToolBase>> | undefined;
      let pending: ReturnType<AnyAgentTool["execute"]> | undefined;
      try {
        // This fixture exercises tool preparation only; the attempt harness owns unrelated runtime state.
        const attempt = {
          config,
          runId: "attribution",
          sessionId: "attribution",
          sessionKey: "agent:main:attribution",
          modelId: "test-model",
          provider: "anthropic",
          model: makeProviderModelFixture({
            id: "test-model",
            provider: "anthropic",
            api: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
          }),
          authProfileStore: { version: 1, profiles: {} },
          admittedRunContext: await admission.admit("embedded"),
          awaitSessionDiffBaseline: async () => {
            entered.resolve();
            await baseline.promise;
          },
        } as EmbeddedRunAttemptInternalParams;
        hoisted.createOpenClawCodingToolsMock.mockReturnValue([]);
        result = await prepareEmbeddedAttemptToolBase({
          attempt,
          agentDir: "/tmp/attribution-agent",
          setup: createAttemptSetupFixture({ sandboxSessionKey: attempt.sessionKey! }),
          markCoreToolStage: () => {},
          onYield: async () => {},
          runAbortController,
          runTrace: { traceId: "1234567890abcdef1234567890abcdef" },
          skillUsagePaths: [],
          skillsSnapshot: undefined,
          codeModeSkills: [],
          toolSearchCatalogExecutor: async () => ({ content: [], details: {} }),
        });
        const builtInOptions = hoisted.createOpenClawCodingToolsMock.mock.calls[0]?.[0];
        expect(builtInOptions?.awaitSessionDiffBaseline).toBe(
          result.toolHookContext.awaitSessionDiffBaseline,
        );
        const tool = wrapToolWithBeforeToolCallHook(
          {
            name: "write",
            label: "Write",
            description: "Write fixture",
            parameters: { type: "object", properties: {} },
            execute,
          },
          result.toolHookContext,
        );
        pending = tool.execute("catalog-attribution", {});
        await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "Catalog tool bypassed attribution",
        );
        expect(execute).not.toHaveBeenCalled();
        if (outcome === "retired source") {
          admission.close();
          baseline.resolve();
        } else {
          baseline.reject(failure);
        }
        await expect(pending).rejects.toThrow();
        expect(runAbortController.signal.aborted).toBe(true);
        if (outcome === "capture invalidated") {
          expect(runAbortController.signal.reason).toBe(failure);
        }
        expect(execute).not.toHaveBeenCalled();
      } finally {
        baseline.resolve();
        await pending?.catch(() => undefined);
        await result?.releaseTools("test-complete");
        result?.toolSurfaceRuntime.cleanup();
        admission.close();
      }
    },
  );

  it.each([
    { name: "ordinary unconfigured", expected: true },
    { name: "dashboard unconfigured", dashboard: true, expected: true },
    { name: "configured", configured: true, expected: false },
    { name: "policy denied", deny: true, expected: false },
    { name: "globally disabled", disabled: true, expected: false },
    { name: "session disabled", sessionDisabled: true, expected: false },
    { name: "native OpenAI", native: true, expected: false },
  ])("keeps the actual callback truthful for $name and clears it on rebuild", async (scenario) => {
    const config: OpenClawConfig = {
      tools: {
        codeMode: false,
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
        sessionKey: scenario.dashboard
          ? "agent:main:dashboard:search-guidance"
          : "agent:main:search-guidance",
        agentDir: "/tmp/search-guidance-agent",
        modelId: "test-model",
        provider: scenario.native ? "openai" : "anthropic",
        model: makeProviderModelFixture({
          id: "test-model",
          provider: scenario.native ? "openai" : "anthropic",
          api: scenario.native ? "openai-responses" : "anthropic-messages",
          baseUrl: scenario.native ? "https://api.openai.com/v1" : "https://api.anthropic.com",
        }),
        authProfileStore: { version: 1, profiles: {} },
        admittedRunContext: await admission.admit("embedded"),
        toolOverrides: scenario.sessionDisabled ? { webSearch: false } : undefined,
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
      expect(hoisted.createOpenClawCodingToolsMock).toHaveBeenCalledTimes(1);
      expect(result.webSearchUnconfigured).toBe(scenario.expected);
      // A disabled factory does not report configuration. Reset must clear the previous fact,
      // rather than relying on a later callback to overwrite it.
      hoisted.createOpenClawCodingToolsMock.mockImplementation(() => []);
      attempt.toolOverrides = { webSearch: false };
      await result.refreshPermissionMode(null, () => {});
      expect(result.webSearchUnconfigured).toBe(false);
      expect(hoisted.createOpenClawCodingToolsMock).toHaveBeenCalledTimes(2);
    } finally {
      await result?.releaseTools("test-complete");
      result?.toolSurfaceRuntime.cleanup();
      admission.close();
    }
  });
});
