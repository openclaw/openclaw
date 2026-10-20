import path from "node:path";
import {
  afterAll,
  afterEach,
  assert,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.entry.js";
import { SessionWorkStartInvalidatedError } from "../../../config/sessions/work-start-error.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../../admitted-run-context.js";
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

async function createAttempt(
  admission: ReturnType<typeof prepareSystemAgentRunAdmission>,
  overrides: Partial<EmbeddedRunAttemptInternalParams>,
) {
  return {
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
    ...overrides,
  } as EmbeddedRunAttemptInternalParams;
}

function prepareTools(
  attempt: EmbeddedRunAttemptInternalParams,
  runAbortController = new AbortController(),
) {
  return prepareEmbeddedAttemptToolBase({
    attempt,
    agentDir: attempt.agentDir ?? "/tmp/attribution-agent",
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
}

describe("prepared missing-search guidance", () => {
  let state: OpenClawTestState;
  let storePath: string;
  const dashboardSessionKey = "agent:main:dashboard:search-guidance";
  const childSessionKey = "agent:main:dashboard:search-denied-child";

  beforeAll(async () => {
    state = await createOpenClawTestState({
      label: "prepared-search-guidance",
      scenario: "minimal",
    });
    storePath = path.join(state.sessionsDir(), "sessions.json");
    await replaceSessionEntry(
      { storePath, sessionKey: dashboardSessionKey },
      { sessionId: "search-guidance", updatedAt: 1 },
    );
    await replaceSessionEntry(
      { storePath, sessionKey: childSessionKey },
      {
        sessionId: "search-denied-child",
        updatedAt: 1,
        spawnDepth: 1,
        spawnedBy: dashboardSessionKey,
        inheritedToolPolicyVersion: 1,
        inheritedToolDeny: ["web_search"],
      },
    );
  });
  afterAll(async () => await state?.cleanup());
  it.each(
    (["built-in", "catalog"] as const).flatMap((surface) =>
      (["retired source", "capture invalidated"] as const).map((outcome) => ({ surface, outcome })),
    ),
  )(
    "aborts $surface tools before parameter preparation or effects ($outcome)",
    async ({ surface, outcome }) => {
      const config: OpenClawConfig = { tools: { codeMode: false, toolSearch: { enabled: false } } };
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "reviewer-caller",
        scopes: [],
        assertCurrent() {},
      });
      const skillsSnapshot = {
        prompt: "",
        skills: [
          {
            name: "autoreview",
            source: { filePath: "/managed/autoreview/SKILL.md", fileHost: "gateway" as const },
          },
        ],
      };
      const admission = prepareSystemAgentRunAdmission(
        config,
        "attribution",
        "main",
        "test",
        undefined,
        authority,
      );
      const entered = createDeferred();
      const baseline = createDeferred();
      const runAbortController = new AbortController();
      const failure = new SessionWorkStartInvalidatedError("capture invalidated");
      const prepare = vi.fn(async (params: unknown) => params);
      const execute = vi.fn(async () => ({ content: [], details: {} }));
      const fixtureTool: AnyAgentTool = {
        name: "write",
        label: "Write",
        description: "Write fixture",
        parameters: { type: "object", properties: {} },
        prepareBeforeToolCallParams: prepare,
        execute,
      };
      let result: Awaited<ReturnType<typeof prepareEmbeddedAttemptToolBase>> | undefined;
      let pending: ReturnType<AnyAgentTool["execute"]> | undefined;
      try {
        const attempt = await createAttempt(admission, {
          config,
          skillsSnapshot,
          awaitSessionDiffBaseline: async () => {
            entered.resolve();
            await baseline.promise;
          },
        });
        // Built-ins must use the factory-forwarded callback, not the catalog hook path.
        hoisted.createOpenClawCodingToolsMock.mockImplementation((options) =>
          surface === "built-in"
            ? [
                wrapToolWithBeforeToolCallHook(fixtureTool, {
                  awaitSessionDiffBaseline: options?.awaitSessionDiffBaseline,
                }),
              ]
            : [],
        );
        result = await prepareTools(attempt, runAbortController);
        const builtInOptions = hoisted.createOpenClawCodingToolsMock.mock.calls[0]?.[0];
        expect(builtInOptions?.pluginExecutionAuthority).toBe(authority);
        expect(builtInOptions?.pluginExecutionSkillsSnapshot).toBe(skillsSnapshot);
        expect(() => builtInOptions?.assertInvocationCurrent?.()).not.toThrow();
        expect(builtInOptions?.awaitSessionDiffBaseline).toBe(
          result.toolHookContext.awaitSessionDiffBaseline,
        );
        const tool =
          surface === "built-in"
            ? result.toolsRaw[0]
            : wrapToolWithBeforeToolCallHook(fixtureTool, result.toolHookContext);
        assert(tool);
        pending = tool.execute(`${surface}-attribution`, {});
        await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          `${surface} tool bypassed attribution`,
        );
        expect(prepare).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        if (outcome === "retired source") {
          admission.close();
          baseline.resolve();
        } else {
          baseline.reject(failure);
        }
        await expect(pending).rejects.toThrow();
        expect(runAbortController.signal.aborted).toBe(true);
        expect(() => builtInOptions?.assertInvocationCurrent?.()).toThrow();
        if (outcome === "capture invalidated") {
          expect(runAbortController.signal.reason).toBe(failure);
        }
        expect(prepare).not.toHaveBeenCalled();
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
    { name: "inherited dashboard policy denied", inheritedDeny: true, expected: false },
    { name: "globally disabled", disabled: true, expected: false },
    { name: "session disabled", sessionDisabled: true, expected: false },
    { name: "native OpenAI", native: true, expected: false },
  ])("keeps the actual callback truthful for $name and clears it on rebuild", async (scenario) => {
    const config: OpenClawConfig = {
      session: { store: storePath },
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
      // Invoke the real callback after dashboard metadata preparation, without a Gateway projection.
      const attempt = await createAttempt(admission, {
        config,
        runId: "search-guidance",
        sessionId: scenario.inheritedDeny ? "search-denied-child" : "search-guidance",
        sessionKey: scenario.inheritedDeny
          ? childSessionKey
          : scenario.dashboard
            ? dashboardSessionKey
            : "agent:main:search-guidance",
        agentDir: state.agentDir(),
        provider: scenario.native ? "openai" : "anthropic",
        model: makeProviderModelFixture({
          id: "test-model",
          provider: scenario.native ? "openai" : "anthropic",
          api: scenario.native ? "openai-responses" : "anthropic-messages",
          baseUrl: scenario.native ? "https://api.openai.com/v1" : "https://api.anthropic.com",
        }),
        toolOverrides: scenario.sessionDisabled ? { webSearch: false } : undefined,
      });
      result = await prepareTools(attempt);
      expect(hoisted.createOpenClawCodingToolsMock).toHaveBeenCalledTimes(1);
      expect(result.webSearchUnconfigured).toBe(scenario.expected);
      // A disabled factory never reports configuration, so rebuild must clear the old fact.
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
