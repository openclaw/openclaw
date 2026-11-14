import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterAll, afterEach, assert, beforeAll, beforeEach, expect, it, vi } from "vitest";
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
import { markCodeModePermissionChangeResult } from "../../code-mode-permission-change.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { getHoisted, resetEmbeddedAttemptHarness } from "./attempt-spawn-workspace.test-support.js";
import { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";

const { createOpenClawCodingToolsMock: codingTools } = getHoisted();
beforeEach(() => resetEmbeddedAttemptHarness());
afterEach(() => vi.restoreAllMocks());

async function createFixture(
  overrides: Partial<EmbeddedRunAttemptInternalParams> = {},
  authority?: Parameters<typeof prepareSystemAgentRunAdmission>[5],
  runAbortController = new AbortController(),
  observeAttempt: (
    attempt: EmbeddedRunAttemptInternalParams,
  ) => EmbeddedRunAttemptInternalParams = (attempt) => attempt,
) {
  await using resources = new AsyncDisposableStack();
  const config = overrides.config ?? { tools: { codeMode: false, toolSearch: { enabled: false } } };
  const admission = prepareSystemAgentRunAdmission(
    config,
    overrides.runId ?? "attribution",
    "main",
    "test",
    undefined,
    authority,
  );
  resources.defer(() => admission.close());
  const provider = overrides.provider ?? "anthropic";
  const native = provider === "openai";
  const attempt = {
    config,
    runId: "attribution",
    sessionId: "attribution",
    sessionKey: "agent:main:attribution",
    modelId: "test-model",
    provider,
    model: makeProviderModelFixture({
      id: "test-model",
      provider,
      api: native ? "openai-responses" : "anthropic-messages",
      baseUrl: native ? "https://api.openai.com/v1" : "https://api.anthropic.com",
    }),
    authProfileStore: { version: 1, profiles: {} },
    admittedRunContext: await admission.admit("embedded"),
    ...overrides,
  } as EmbeddedRunAttemptInternalParams;
  const result = await prepareEmbeddedAttemptToolBase({
    attempt: observeAttempt(attempt),
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
  resources.defer(() => result.toolSurfaceRuntime.cleanup());
  resources.defer(() => result.releaseTools("test-complete"));
  const lifetime = resources.move();
  return { attempt, result, admission, [Symbol.asyncDispose]: () => lifetime.disposeAsync() };
}

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

it.each(["completion", "permission change"] as const)(
  "retained %s signals release the retiring run without changing cancellation",
  async (outcome) => {
    class RetiringRun {
      settle(result: Awaited<ReturnType<typeof prepareEmbeddedAttemptToolBase>>) {
        return outcome === "completion"
          ? result.releaseTools("completion")
          : result.refreshPermissionMode(null, () => {});
      }
    }
    const retained = await (async () => {
      await using fixture = await createFixture();
      const signal = fixture.result.toolAbortSignal;
      let reasonAtAbort: unknown;
      signal.addEventListener("abort", () => (reasonAtAbort = signal.reason), { once: true });
      await new RetiringRun().settle(fixture.result);
      return { signal, reasonAtAbort };
    })();
    // Error matchers can materialize the lazy stack and hide the retained caller.
    await nextTurn();
    expect(queryObjects(RetiringRun)).toBe(0);
    expect(retained.signal.aborted).toBe(true);
    expect(retained.signal.reason).toBe(retained.reasonAtAbort);
    if (outcome === "completion") {
      expect(retained.signal.reason).toBeInstanceOf(DOMException);
      expect(retained.signal.reason).toHaveProperty("name", "AbortError");
    } else {
      const details = { status: "failed", code: "aborted", error: "original failure" };
      markCodeModePermissionChangeResult(details, retained.signal);
      expect(details.error).toContain("Permission change interrupted this Code Mode program.");
    }
  },
);

it("prepares tools without enumerating unrelated attempt state", async () => {
  const enumerate = vi.fn((target: EmbeddedRunAttemptInternalParams) => Reflect.ownKeys(target));
  codingTools.mockReturnValue([createStubTool("read")]);
  await using fixture = await createFixture(
    {},
    undefined,
    undefined,
    (attempt) => new Proxy(attempt, { ownKeys: enumerate }),
  );
  expect(fixture.result.toolsRaw.map((tool) => tool.name)).toEqual(["read"]);
  expect(codingTools).toHaveBeenCalledTimes(1);
  expect(enumerate).not.toHaveBeenCalled();
});

it.each(
  (["built-in", "catalog"] as const).flatMap((surface) =>
    (["retired source", "capture invalidated"] as const).map((outcome) => ({ surface, outcome })),
  ),
)(
  "aborts $surface tools before parameter preparation or effects ($outcome)",
  async ({ surface, outcome }) => {
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
    const entered = createDeferred();
    const baseline = createDeferred();
    const runAbortController = new AbortController();
    const failure = new SessionWorkStartInvalidatedError("capture invalidated");
    const prepare = vi.fn(async (params: unknown) => params);
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const fixtureTool: AnyAgentTool = {
      ...createStubTool("write"),
      prepareBeforeToolCallParams: prepare,
      execute,
    };
    let pending: ReturnType<AnyAgentTool["execute"]> | undefined;
    // Built-ins must use the factory-forwarded callback, not the catalog hook path.
    codingTools.mockImplementation((options) =>
      surface === "built-in"
        ? [
            wrapToolWithBeforeToolCallHook(fixtureTool, {
              awaitSessionDiffBaseline: options?.awaitSessionDiffBaseline,
            }),
          ]
        : [],
    );
    await using fixture = await createFixture(
      {
        skillsSnapshot,
        awaitSessionDiffBaseline: async () => {
          entered.resolve();
          await baseline.promise;
        },
      },
      authority,
      runAbortController,
    );
    const { result, admission } = fixture;
    try {
      const builtInOptions = codingTools.mock.calls[0]?.[0];
      expect(builtInOptions?.pluginExecutionAuthority).toBe(authority);
      expect(builtInOptions?.pluginExecutionSkillsSnapshot).toBe(skillsSnapshot);
      expect(() => builtInOptions?.assertInvocationCurrent?.()).not.toThrow();
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
      expect([prepare.mock.calls, execute.mock.calls]).toEqual([[], []]);
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
      expect([prepare.mock.calls, execute.mock.calls]).toEqual([[], []]);
    } finally {
      baseline.resolve();
      await pending?.catch(() => undefined);
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
  { name: "native OpenAI", native: true, expected: false, callable: true },
  { name: "native denied", native: true, deny: true, expected: false },
  { name: "native inherited denial", native: true, inheritedDeny: true, expected: false },
  { name: "native disabled", native: true, disabled: true, expected: false },
  { name: "native session disabled", native: true, sessionDisabled: true, expected: false },
  { name: "native runtime denied", native: true, runtimeDenied: true, expected: false },
  { name: "native execution denied", native: true, executionDenied: true, expected: false },
  { name: "native tools disabled", native: true, toolsDisabled: true, expected: false },
  { name: "native raw run", native: true, raw: true, expected: false },
])("keeps search guidance and admission truthful for $name on rebuild", async (scenario) => {
  const config: OpenClawConfig = {
    session: { store: storePath },
    tools: {
      codeMode: true,
      allow: ["web_search"],
      toolSearch: { enabled: false },
      ...(scenario.deny ? { deny: ["web_search"] } : {}),
      ...(scenario.disabled ? { web: { search: { enabled: false } } } : {}),
    },
  };
  codingTools.mockImplementation((options) => {
    options?.onWebSearchConfiguration?.(scenario.configured === true);
    return [];
  });
  // Invoke the real callback after dashboard metadata preparation, without a Gateway projection.
  await using fixture = await createFixture({
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
    toolsAllow: scenario.runtimeDenied ? ["exec"] : ["web_search", "exec"],
    toolExecutionAllow: scenario.executionDenied ? ["read"] : undefined,
    disableTools: scenario.toolsDisabled,
    modelRun: scenario.raw,
    toolOverrides: scenario.sessionDisabled ? { webSearch: false } : undefined,
  });
  const { result, attempt } = fixture;
  expect(result.webSearchUnconfigured).toBe(scenario.expected);
  const catalog = await prepareEmbeddedAttemptToolCatalog({
    attempt,
    setup: createAttemptSetupFixture({ sandboxSessionKey: attempt.sessionKey! }),
    preparedToolBase: result,
    bundleTools: { clientTools: undefined, uncompactedEffectiveTools: result.toolsRaw },
    abortSignal: result.toolAbortSignal,
    executeCodeModeTool: async () => ({ content: [], details: {} }),
  });
  expect(catalog.toolSearch.catalogToolCount).toBe(0);
  expect(catalog.toolSearchRunPlan.hasCallableTools).toBe(scenario.callable === true);
  if (scenario.callable) {
    expect(catalog.emptyExplicitToolAllowlistError).toBeNull();
    expect(catalog.toolSearchRunPlan.liveAllowedToolNames.has("web_search")).toBe(false);
  }
  // A disabled factory never reports configuration, so rebuild must clear the old fact.
  codingTools.mockImplementation(() => []);
  attempt.toolOverrides = { webSearch: false };
  await result.refreshPermissionMode(null, () => {});
  expect(result.webSearchUnconfigured).toBe(false);
  catalog.refreshTools(() => {});
  expect(catalog.toolSearchRunPlan.hasCallableTools).toBe(false);
});
