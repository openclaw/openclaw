import { performance } from "node:perf_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentRunDelegatedAuthority } from "../infra/agent-run-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { expectNoCalls } from "../test-utils/mock-call-assertions.js";
import type { AdmittedRunContext } from "./admitted-run-context.js";
import {
  isolatedAssistant,
  isolatedReply as reply,
  isolatedErrorReply as errorReply,
  prepareQuotaProfiles,
  isolatedCompletionMocks as mocks,
  runIsolatedCompletion,
  preparedModelRuntime,
  registerIsolatedHarness,
  registerIsolatedRuntime,
  releaseRuntimeLease,
  isolatedRequest,
  resetIsolatedCompletionTestState,
  type IsolatedCliRunParams,
} from "./isolated-completion.test-support.js";
import type * as RuntimeAuth from "./runtime-plan/prepare-auth.js";

// The shared fixture must register mocks before other runtime modules load.
const { createDeferred, awaitGateBeforeSettlement: waitForBarrier } =
  await import("../../test/helpers/promise.js");
const { AsyncLocalStorage } = await import("node:async_hooks");
const { createEmptyPluginRegistry } = await import("../plugins/registry-empty.js");
const { getPluginRuntimeGatewayRequestScope, withPluginRuntimeRegistryScope } =
  await import("../plugins/runtime/gateway-request-scope.js");
const { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } =
  await import("../shared/async-work-scope.js");
const { validateAgentRunDelegatedAuthority } = await import("../infra/agent-run-registry.js");
const { mintSecretSentinel } = await import("../secrets/sentinel.js");
const { getAdmittedRunDelegatedAuthority } = await import("./admitted-run-context.js");
const { resolveModelFallbackError } = await import("./failover-error.js");
const { PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE } = await import("../llm/types.js");
const { prepareUtilityCompletionForAgent } = await import("./utility-completion.js");

beforeEach(resetIsolatedCompletionTestState);

function expectCall(mock: unknown, shape: object) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(shape));
}

function complete(overrides: Partial<Parameters<typeof runIsolatedCompletion>[0]> = {}) {
  return runIsolatedCompletion(isolatedRequest(overrides));
}

function cliReply(text = "done") {
  mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
  mocks.runCliAgent.mockResolvedValue({ payloads: [{ text }] });
}

function cliComplete(overrides: Parameters<typeof complete>[0] = {}) {
  return complete({
    provider: "anthropic",
    model: "claude-test",
    agentHarnessRuntimeOverride: "claude-cli",
    ...overrides,
  });
}

const cliOwner = { kind: "cli", id: "claude-cli" };
const runtimeLease = () => ({
  snapshot: preparedModelRuntime,
  [Symbol.asyncDispose]: releaseRuntimeLease,
});
const admittedFixture = () => ({
  config: { agents: { defaults: { workspace: "/tmp/admitted-workspace" } } },
  agentDir: "/tmp/admitted-agent",
  workspaceDir: "/tmp/admitted-workspace",
});
const preparedModel = () => ({
  model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
  auth: { apiKey: "synthetic-key", mode: "api-key", source: "test" },
});
const toolCall = { type: "toolCall", id: "call-1", name: "update_plan", arguments: {} } as const;

type PreparationStage = "runtime" | "acquisition" | "plugin" | "host auth" | "host-auth";
function pausePreparation(stage: PreparationStage, pause: () => Promise<void>) {
  if (stage === "runtime" || stage === "acquisition") {
    mocks.acquireAgentRunPreparedModelRuntime.mockImplementationOnce(async () => {
      await pause();
      return runtimeLease();
    });
  } else if (stage === "plugin") {
    mocks.ensureSelectedAgentHarnessPlugin.mockImplementationOnce(pause);
  } else {
    mocks.prepareSimpleCompletionModel.mockImplementationOnce(async () => {
      await pause();
      return preparedModel();
    });
  }
}

function pausedHarness(stage: PreparationStage, version: "v1" | "v2" = "v2") {
  const entered = createDeferred(),
    release = createDeferred();
  const expired = new Error("The completion owner retired.");
  let current = true;
  const dispatch = vi.fn(async () => reply("done"));
  registerIsolatedRuntime(version, dispatch);
  pausePreparation(stage, async () => {
    entered.resolve();
    await release.promise;
  });
  return {
    entered,
    release,
    expired,
    dispatch,
    retire() {
      current = false;
    },
    assertCurrent(this: void) {
      if (!current) {
        throw expired;
      }
    },
  };
}

it.each([false, true])(
  "routes an automatic utility completion with provider auth=%s",
  async (auth) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "anthropic/claude-opus-5",
          models: { "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } } },
        },
      },
    };
    const manifestPlugins = [
      {
        id: "anthropic",
        modelCatalog: {
          providers: {
            anthropic: {
              defaultUtilityModel: "claude-haiku-4-5",
              models: [{ id: "claude-haiku-4-5" }, { id: "claude-opus-5" }],
            },
          },
        },
      },
    ] as unknown as PluginMetadataSnapshot["plugins"];
    mocks.isCliRuntimeAliasForProvider.mockImplementation(
      ({ runtime, provider }) => runtime === "claude-cli" && provider === "anthropic",
    );
    mocks.hasAvailableAuthForProvider.mockResolvedValue(auth);
    mocks.prepareSimpleCompletionModel.mockResolvedValue(
      auth
        ? {
            model: { provider: "anthropic", id: "claude-haiku-4-5", api: "anthropic-messages" },
            auth: preparedModel().auth,
          }
        : { error: 'No API key found for provider "anthropic".' },
    );
    mocks.runCliAgent.mockResolvedValue({ payloads: [{ text: "Utility result" }] });
    const dispatch = vi.fn(async () => reply("Utility result"));
    registerIsolatedHarness({ id: "openclaw", runIsolatedCompletionV2: dispatch });
    const prepared = await prepareUtilityCompletionForAgent({
      cfg,
      agentId: "main",
      useUtilityModel: true,
      manifestPlugins,
    });
    const request = {
      ...prepared,
      systemPrompt: "Return JSON.",
      prompt: "Do the task.",
      timeoutMs: 1_000,
    };

    expect(prepared.agentHarnessRuntimeOverride).toBe("claude-cli");

    await expect(runIsolatedCompletion(request)).resolves.toMatchObject({
      text: "Utility result",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      owner: cliOwner,
    });
    expectNoCalls(mocks.prepareSimpleCompletionModel, dispatch);
    expectCall(mocks.runCliAgent, {
      provider: "claude-cli",
      modelProvider: "anthropic",
      model: "claude-haiku-4-5",
      isolatedCompletion: true,
    });

    if (!auth) {
      // Without the borrowed owner, the same credentialless request reproduces #138789.
      await expect(
        runIsolatedCompletion({ ...request, agentHarnessRuntimeOverride: undefined }),
      ).rejects.toThrow('No API key found for provider "anthropic"');
      expect(mocks.prepareSimpleCompletionModel).toHaveBeenCalledOnce();
      expect(dispatch).not.toHaveBeenCalled();
      expect(mocks.runCliAgent).toHaveBeenCalledOnce();
    }
  },
);

describe("runIsolatedCompletion", () => {
  it("rejects the admitted required-worker policy before selecting an execution owner", async () => {
    mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
    mocks.acquireAgentRunPreparedModelRuntime.mockImplementationOnce(async () => {
      Object.assign(preparedModelRuntime, {
        config: { cloudWorkers: { requiredProfile: "dedicated" } },
      });
      return runtimeLease();
    });
    await expect(complete()).rejects.toMatchObject({
      code: "unsupported",
      message: expect.stringContaining("requiredProfile"),
    });
    expectNoCalls(
      mocks.ensureSelectedAgentHarnessPlugin,
      mocks.runCliAgent,
      mocks.prepareSimpleCompletionModel,
      mocks.resolveModelAsync,
    );
    expect(releaseRuntimeLease).toHaveBeenCalledOnce();
  });

  it.each([
    ["429 Too many requests", 400],
    ["You have hit your ChatGPT usage limit. Try again in 120 minutes.", 0],
    ["Your credit balance is too low to access the API.", 0],
    ["429 Too many requests", 1_000],
  ] as const)(
    "rotates quota failure %s within one deadline (%s ms)",
    async (errorMessage, elapsedMs) => {
      prepareQuotaProfiles();
      using now = vi.spyOn(performance, "now").mockReturnValue(1_000);
      const dispatch = vi
        .fn()
        .mockImplementationOnce(async () => {
          now.mockReturnValue(1_000 + elapsedMs);
          return errorReply(errorMessage);
        })
        .mockResolvedValueOnce(reply("recovered"));
      registerIsolatedHarness({ authBootstrap: "harness", runIsolatedCompletionV2: dispatch });

      const completion = complete();
      if (elapsedMs === 1_000) {
        await expect(completion).rejects.toThrow("timed out");
        expect(dispatch).toHaveBeenCalledOnce();
      } else {
        await expect(completion).resolves.toMatchObject({ text: "recovered" });
        expect(dispatch).toHaveBeenCalledTimes(2);
        expect(
          dispatch.mock.calls.map(([params]) => params.authorization.plan.forwardedAuthProfileId),
        ).toEqual(["openai:first", "openai:backup"]);
        expect(dispatch).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ timeoutMs: 1_000 - elapsedMs }),
        );
      }
      expect(releaseRuntimeLease).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "preserves quota failure and profile limits (locked: %s)",
    async (locked) => {
      prepareQuotaProfiles();
      if (locked) {
        const { prepareAgentRuntimeAuth } = await vi.importActual<typeof RuntimeAuth>(
          "./runtime-plan/prepare-auth.js",
        );
        mocks.prepareAgentRuntimeAuth.mockImplementationOnce(prepareAgentRuntimeAuth);
      }
      const dispatch = vi
        .fn()
        .mockResolvedValueOnce(errorReply("429 Too many requests. Retry after 90 seconds."))
        .mockResolvedValueOnce(
          locked
            ? reply("unauthorized backup result")
            : errorReply("429 Too many requests. Retry after 120 seconds."),
        );
      registerIsolatedHarness({ authBootstrap: "harness", runIsolatedCompletionV2: dispatch });
      const error = await complete(locked ? { authProfileId: "openai:first" } : {}).catch(
        (cause: unknown) => cause,
      );
      expect(error).toMatchObject({ code: "output-rejected" });
      if (!locked) {
        expect(error).toMatchObject({ cause: { retryAfterMs: 90_000 } });
        expect(resolveModelFallbackError(error)).toMatchObject({
          kind: "failover",
          error: { reason: "rate_limit" },
        });
      }
      expect(dispatch).toHaveBeenCalledTimes(locked ? 1 : 2);
    },
  );

  it.each(["terminal", "tool", "aborted", "authorization", "unknown"] as const)(
    "does not rotate prepared profiles after %s output",
    async (kind) => {
      prepareQuotaProfiles();
      const assistant = isolatedAssistant(
        kind === "tool"
          ? [toolCall]
          : kind === "terminal"
            ? [{ type: "text", text: "Partial output must not be replayed." }]
            : [],
        kind === "aborted" ? "aborted" : "error",
      );
      assistant.errorMessage =
        kind === "authorization"
          ? "403 Permission denied"
          : kind === "unknown"
            ? "Unknown failure"
            : "429 Too many requests";
      if (kind === "terminal") {
        assistant.errorCode = PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE;
      }
      const dispatch = vi.fn().mockResolvedValue({ assistant });
      registerIsolatedHarness({ authBootstrap: "harness", runIsolatedCompletionV2: dispatch });
      const error = await complete().catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        code: "output-rejected",
        message: assistant.errorMessage,
      });
      if (kind === "terminal") {
        expect(resolveModelFallbackError(error)).toMatchObject({ kind: "terminal" });
      }
      expect(dispatch).toHaveBeenCalledOnce();
      expect(releaseRuntimeLease).toHaveBeenCalledOnce();
    },
  );

  it.each(["retired", "aborted"] as const)(
    "does not rotate after a returned quota error when %s",
    async (state) => {
      prepareQuotaProfiles();
      const controller = new AbortController();
      let current = true;
      const expired = new Error("Completion owner retired.");
      const dispatch = vi.fn(async () => {
        if (state === "retired") {
          current = false;
        } else {
          controller.abort(expired);
        }
        return errorReply("429 Too many requests");
      });
      registerIsolatedHarness({ authBootstrap: "harness", runIsolatedCompletionV2: dispatch });
      await expect(
        complete({
          abortSignal: controller.signal,
          assertCurrent() {
            if (!current) {
              throw expired;
            }
          },
        }),
      ).rejects.toBe(expired);
      expect(dispatch).toHaveBeenCalledOnce();
      expect(releaseRuntimeLease).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["runtime", "v2"],
    ["plugin", "v2"],
    ["host auth", "v1"],
    ["host auth", "v2"],
  ] as const)("rejects retired authority after %s preparation for %s", async (stage, version) => {
    const owner = pausedHarness(stage, version);
    const completion = complete({ assertCurrent: owner.assertCurrent });
    try {
      await waitForBarrier(owner.entered.promise, completion, "Preparation not reached");
      owner.retire();
      owner.release.resolve();
      await expect(completion).rejects.toBe(owner.expired);
      expect(owner.dispatch).not.toHaveBeenCalled();
      expect(releaseRuntimeLease).toHaveBeenCalledOnce();
    } finally {
      owner.release.resolve();
      await Promise.allSettled([completion]);
    }
  });

  it.each(["claude-cli", "anthropic"])(
    "keeps the CLI execution owner for a %s utility model without resolving HTTP credentials",
    async (provider) => {
      mocks.resolveCliRuntimeCanonicalProvider.mockReturnValue(
        provider === "claude-cli" ? "anthropic" : undefined,
      );
      mocks.resolveCliRuntimeExecutionProvider.mockReturnValue(
        provider === "anthropic" ? "claude-cli" : undefined,
      );
      mocks.isCliRuntimeAliasForProvider.mockImplementation(
        ({ runtime, provider: modelProvider }) =>
          runtime === "claude-cli" && modelProvider === "anthropic",
      );
      mocks.prepareSimpleCompletionModel.mockRejectedValue(
        new Error("native-auth markers must never become HTTP credentials"),
      );
      mocks.runCliAgent.mockResolvedValue({ payloads: [{ text: "Utility result" }] });

      await expect(
        complete({ provider, model: "claude-test", agentHarnessRuntimeOverride: undefined }),
      ).resolves.toMatchObject({
        text: "Utility result",
        provider: "anthropic",
        owner: cliOwner,
      });
      expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
      expectCall(mocks.runCliAgent, {
        provider: "claude-cli",
        modelProvider: "anthropic",
        isolatedCompletion: true,
        cliToolAvailability: { native: [], openClaw: [] },
      });
    },
  );

  it("forwards the native output schema to a V2 harness", async () => {
    const assistant = isolatedAssistant([{ type: "text", text: '{"ok":true}' }]);
    const dispatch = vi.fn(async (_params: unknown) => ({ assistant }));
    registerIsolatedHarness({ runIsolatedCompletionV2: dispatch });
    const outputSchema = { type: "object" };

    await runIsolatedCompletion({ ...isolatedRequest(), outputSchema });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ outputSchema }));
  });

  it.each([false, true])(
    "captures call-owned choices and authority before admission (retired: %s)",
    async (retired) => {
      const admitted = admittedFixture();
      Object.assign(preparedModelRuntime, admitted);
      const owner = pausedHarness("runtime");
      const mutableRequest = {
        ...isolatedRequest(),
        authProfileId: "openai:original",
        streamParams: { maxTokens: 21, temperature: 0.1 },
        assertCurrent: owner.assertCurrent,
      };
      const completion = runIsolatedCompletion(mutableRequest);
      try {
        await owner.entered.promise;
        mutableRequest.model = "changed-model";
        mutableRequest.authProfileId = "openai:changed";
        mutableRequest.streamParams.maxTokens = 84;
        mutableRequest.streamParams.temperature = 0.9;
        mutableRequest.agentHarnessRuntimeOverride = "changed-runtime";
        mutableRequest.assertCurrent = () => {};
        if (retired) {
          owner.retire();
        }
        owner.release.resolve();

        if (retired) {
          await expect(completion).rejects.toBe(owner.expired);
          expectNoCalls(owner.dispatch, mocks.prepareSimpleCompletionModel);
        } else {
          await expect(completion).resolves.toMatchObject({ text: "done" });
          expectCall(mocks.ensureSelectedAgentHarnessPlugin, admitted);
          expect(mocks.prepareSimpleCompletionModel).toHaveBeenCalledWith(
            expect.objectContaining({
              cfg: admitted.config,
              agentDir: admitted.agentDir,
              workspaceDir: admitted.workspaceDir,
              preparedModelRuntime,
              bindAuthOwner: true,
              provider: "openai",
              modelId: "gpt-test",
              profileId: "openai:original",
            }),
            expect.any(Function),
          );
          expect(owner.dispatch).toHaveBeenCalledOnce();
          expectCall(owner.dispatch, { streamParams: { maxTokens: 21, temperature: 0.1 } });
        }
        expect(releaseRuntimeLease).toHaveBeenCalledOnce();
      } finally {
        owner.release.resolve();
        await Promise.allSettled([completion]);
      }
    },
  );

  it.each(["v1", "v2"] as const)(
    "unwraps credentials for %s and retires its dispatch callback on completion",
    async (version) => {
      const apiKey = mintSecretSentinel("github-source-token", { label: "isolated-auth" });
      const authorization = mintSecretSentinel("Bearer github-source-token", {
        label: "isolated-header",
      });
      mocks.prepareSimpleCompletionModel.mockResolvedValueOnce({
        model: {
          provider: "github-copilot",
          id: "gpt-test",
          api: "openai-responses",
          headers: { Authorization: authorization },
        },
        auth: {
          apiKey,
          source: "profile:github-copilot:test",
          mode: "token",
        },
        sourceAuthFingerprint: "fingerprint",
      });
      const dispatch = vi.fn();
      let dispatchLater: (() => void) | undefined;
      const runIsolatedCompletionHarness = vi.fn(async (params: { assertCurrent?: () => void }) => {
        dispatchLater = () => {
          params.assertCurrent?.();
          dispatch();
        };
        return reply("done");
      });
      registerIsolatedHarness({
        id: "copilot",
        label: "Copilot",
        ...(version === "v1"
          ? { runIsolatedCompletion: runIsolatedCompletionHarness }
          : { runIsolatedCompletionV2: runIsolatedCompletionHarness }),
      });

      await complete({ provider: "github-copilot", agentHarnessRuntimeOverride: "copilot" });

      if (!dispatchLater) {
        throw new Error("The harness did not receive its dispatch callback.");
      }
      expect(dispatchLater).toThrow("Isolated completion has ended");
      expect(dispatch).not.toHaveBeenCalled();
      const expectedCredentials = {
        auth: expect.objectContaining({ apiKey: "github-source-token" }),
        model: expect.objectContaining({
          headers: { Authorization: "Bearer github-source-token" },
        }),
      };
      expect(runIsolatedCompletionHarness).toHaveBeenCalledWith(
        expect.objectContaining(
          version === "v1"
            ? expectedCredentials
            : { authorization: expect.objectContaining({ owner: "host", ...expectedCredentials }) },
        ),
      );
    },
  );

  it("rejects a non-adopting explicit harness despite an available CLI candidate", async () => {
    mocks.resolveCliRuntimeExecutionProvider.mockReturnValue("claude-cli");
    registerIsolatedHarness({ id: "external", label: "External" });
    await expect(complete({ agentHarnessRuntimeOverride: "external" })).rejects.toThrow(
      "does not support isolated completion",
    );
    expectNoCalls(mocks.prepareSimpleCompletionModel, mocks.runCliAgent);
  });

  it.each<{
    assistant: ReturnType<typeof isolatedAssistant>;
    message?: string;
    classification?: "overloaded";
  }>([
    {
      assistant: isolatedAssistant([toolCall]),
      message: "returned a tool call",
    },
    {
      ...errorReply("529 Overloaded"),
      classification: "overloaded",
    },
  ])(
    "rejects invalid output and preserves its failure classification: %#",
    async ({ assistant, message, classification }) => {
      registerIsolatedHarness({ runIsolatedCompletion: vi.fn(async () => ({ assistant })) });
      const error = await complete().catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: "output-rejected" });
      if (message) {
        expect(error).toMatchObject({ message: expect.stringContaining(message) });
      }
      if (classification) {
        expect(resolveModelFallbackError(error)).toMatchObject({
          kind: "failover",
          error: { reason: classification },
        });
      }
      expect(releaseRuntimeLease).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "allows thinking-only output only for strict title requests (CLI: %s, strict: %s)",
    async (cli, strict) => {
      mocks.isCliRuntimeAliasForProvider.mockReturnValue(cli);
      mocks.runCliAgent.mockResolvedValue({ payloads: [{ text: "hidden", isReasoning: true }] });
      registerIsolatedHarness({
        runIsolatedCompletion: vi.fn(async () => ({
          assistant: isolatedAssistant([{ type: "thinking", thinking: "hidden" }]),
        })),
      });

      const result = complete(strict ? { outputTextPolicy: "strict-visible" } : {});
      if (strict) {
        await expect(result).resolves.toMatchObject({ text: "" });
      } else {
        await expect(result).rejects.toMatchObject({
          code: "output-rejected",
          message: expect.stringContaining("empty output"),
        });
      }
      if (cli) {
        expectCall(mocks.runCliAgent, { outputTextPolicy: strict ? "strict-visible" : undefined });
      }
    },
  );

  it.each([
    undefined,
    "session-activity-summary",
    "conversation-label",
    "session-observer",
  ] as const)(
    "routes purpose %s through one empty-tool CLI run with reported usage",
    async (purpose) => {
      const usage = { input: 8, output: 3, cacheRead: 2, total: 13 };
      cliReply();
      mocks.runCliAgent.mockResolvedValue({
        payloads: [{ text: '{"cli":true}' }],
        meta: { agentMeta: { usage } },
      });

      await expect(cliComplete({ purpose })).resolves.toStrictEqual({
        text: '{"cli":true}',
        provider: "anthropic",
        model: "claude-test",
        owner: cliOwner,
        usage,
      });
      expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
      expectCall(mocks.runCliAgent, {
        provider: "claude-cli",
        modelProvider: "anthropic",
        authProfileId: undefined,
        executionMode: "side-question",
        isolatedCompletion: true,
        disableTools: true,
        cliToolAvailability: { native: [], openClaw: [] },
        isolatedCompletionPurpose: purpose ?? "isolated-completion",
        disableCliLiveSession: true,
        timeoutMs: expect.any(Number),
        model: "claude-test",
      });
      const params = mocks.runCliAgent.mock.calls[0]?.[0];
      expect(params?.timeoutMs).toBeGreaterThan(0);
      expect(params?.timeoutMs).toBeLessThanOrEqual(1_000);
      expect(params?.trigger).toBeUndefined();
    },
  );

  it.each([
    ["ordered managed profile", undefined, "anthropic:ordered"],
    ["native-login control", undefined, undefined],
    ["explicit managed profile", "anthropic:locked", "anthropic:locked"],
    ["explicit native login", "anthropic:claude-cli", undefined],
  ] as const)(
    "forwards the shared CLI auth selection for %s",
    async (_description, requestedProfile, selectedProfile) => {
      cliReply("isolated result");
      mocks.cliBackendAcceptsAuthProfileForwarding.mockReturnValue(true);
      mocks.resolveCliExecutionAuthProfileId.mockResolvedValue(selectedProfile);
      await expect(cliComplete({ authProfileId: requestedProfile })).resolves.toMatchObject({
        text: "isolated result",
        owner: cliOwner,
      });

      expect(mocks.resolveCliExecutionAuthProfileId).toHaveBeenCalledWith({
        cliExecutionProvider: "claude-cli",
        authProfileProvider: "anthropic",
        config: expect.any(Object),
        agentDir: "/tmp/agent",
        selected: { authProfileId: requestedProfile },
      });
      expectCall(mocks.runCliAgent, { authProfileId: selectedProfile });
    },
  );

  it("keeps concurrent CLI isolated completions independently admitted", async () => {
    const admittedContext = admittedFixture();
    Object.assign(preparedModelRuntime, admittedContext);
    mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const firstStarted = createDeferred();
    const bothStarted = createDeferred();
    const calls: Array<{
      admitted: AdmittedRunContext;
      authority: AgentRunDelegatedAuthority;
      params: IsolatedCliRunParams;
      release: ReturnType<typeof createDeferred<void>>;
    }> = [];
    mocks.runCliAgent.mockImplementation(async (params) => {
      expect(params).toMatchObject(admittedContext);
      const admitted = await params.preparedRunAdmission.admit("embedded");
      const authority = getAdmittedRunDelegatedAuthority(admitted);
      if (!authority) {
        throw new Error("expected active isolated completion authority");
      }
      const release = createDeferred();
      calls.push({ admitted, authority, params, release });
      if (calls.length === 1) {
        firstStarted.resolve();
      }
      if (calls.length === 2) {
        bothStarted.resolve();
      }
      await release.promise;
      return { payloads: [{ text: `done: ${params.prompt}` }] };
    });

    const first = complete({ prompt: "first" });
    let second: ReturnType<typeof runIsolatedCompletion> | undefined;
    try {
      await waitForBarrier(firstStarted.promise, first, "First completion exited before barrier");
      second = complete({ prompt: "second" });
      await waitForBarrier(
        bothStarted.promise,
        Promise.all([first, second]),
        "Completions exited before barrier",
      );
      const firstCall = calls.find(({ params }) => params.prompt === "first");
      const secondCall = calls.find(({ params }) => params.prompt === "second");
      if (!firstCall || !secondCall) {
        throw new Error("expected both isolated completions to start");
      }
      expectCall(mocks.ensureSelectedAgentHarnessPlugin, admittedContext);
      for (const { params, admitted, authority } of calls) {
        expect(params.runId).toBe(params.sessionId);
        expect(admitted.operationalRunInstance.runId).toBe(params.runId);
        expect(validateAgentRunDelegatedAuthority(authority)).toBe(true);
      }
      expect(firstCall.params.runId).not.toBe(secondCall.params.runId);

      firstCall.release.resolve();
      await expect(first).resolves.toMatchObject({ text: "done: first" });
      expect(validateAgentRunDelegatedAuthority(firstCall.authority)).toBe(false);
      expect(validateAgentRunDelegatedAuthority(secondCall.authority)).toBe(true);

      secondCall.release.resolve();
      await expect(second).resolves.toMatchObject({ text: "done: second" });
      expect(validateAgentRunDelegatedAuthority(secondCall.authority)).toBe(false);
    } finally {
      for (const call of calls) {
        call.release.resolve();
      }
      await Promise.allSettled(second ? [first, second] : [first]);
      clock.mockRestore();
    }
  });

  it("keeps the explicit CLI profile and reports its normalized model", async () => {
    cliReply();
    mocks.resolveCliBackendConfig.mockReturnValue({
      config: { command: "gemini", modelAliases: { flash: "gemini-3.1-flash-preview" } },
    });
    await expect(
      complete({
        provider: "google",
        model: "flash",
        authProfileId: "google:locked",
        agentHarnessRuntimeOverride: "google-gemini-cli",
      }),
    ).resolves.toEqual({
      text: "done",
      provider: "google",
      model: "gemini-3.1-flash-preview",
      owner: { kind: "cli", id: "google-gemini-cli" },
    });
    expectCall(mocks.runCliAgent, { authProfileId: "google:locked" });
  });
});

describe("isolated completion work ownership", () => {
  it.each(["acquisition", "host-auth"] as const)(
    "owns %s descendants and preserves parent cancellation context",
    async (stage) => {
      const parent = new AsyncWorkScope();
      const caller = new AbortController();
      const callerReason = new Error("isolated caller cancelled");
      const parentReason = new Error("isolated parent closing");
      const callerRegistry = createEmptyPluginRegistry();
      const selectedRegistry = createEmptyPluginRegistry();
      const foreignRegistry = createEmptyPluginRegistry();
      Object.assign(preparedModelRuntime, { pluginRegistry: selectedRegistry });
      let cancellationRegistryMatches = false;
      const entered = createDeferred();
      const finishSetup = createDeferred();
      const finishTail = createDeferred();
      const tails: Promise<unknown>[] = [];
      let observedReason: unknown;
      let cancellationScopeMatches = false;
      const pause = async () => {
        const signal = getAsyncWorkSignal();
        if (!signal) {
          throw new Error("Setup did not inherit its actual work owner");
        }
        signal.addEventListener(
          "abort",
          () => {
            observedReason = signal.reason;
            cancellationScopeMatches = getAsyncWorkSignal() === signal;
            cancellationRegistryMatches =
              getPluginRuntimeGatewayRequestScope()?.pluginRegistry ===
              (stage === "acquisition" ? callerRegistry : selectedRegistry);
            tails.push(trackAsyncWork(() => finishTail.promise));
          },
          { once: true },
        );
        entered.resolve();
        await finishSetup.promise;
      };
      pausePreparation(stage, pause);
      const dispatch = vi.fn(async () => reply("done"));
      registerIsolatedHarness({ runIsolatedCompletionV2: dispatch });
      const completion = withPluginRuntimeRegistryScope(callerRegistry, () =>
        parent.run(() => complete({ abortSignal: caller.signal })),
      );
      let drained = false;
      let drainage: Promise<void> | undefined;
      try {
        await waitForBarrier(entered.promise, completion, "Completion ended before setup entered");
        caller.abort(callerReason);
        withPluginRuntimeRegistryScope(foreignRegistry, () => parent.beginClose(parentReason));
        expect.soft(cancellationRegistryMatches).toBe(true);
        expect.soft(observedReason).toBe(parentReason);
        expect.soft(cancellationScopeMatches).toBe(true);
        drainage = parent.drain().then(() => {
          drained = true;
        });
        finishSetup.resolve();
        await expect(completion).rejects.toBe(callerReason);
        expect(dispatch).not.toHaveBeenCalled();
        expect.soft(releaseRuntimeLease).not.toHaveBeenCalled();
        expect.soft(drained).toBe(false);
        finishTail.resolve();
        await drainage;
        expect(releaseRuntimeLease).toHaveBeenCalledOnce();
      } finally {
        finishSetup.resolve();
        finishTail.resolve();
        await Promise.allSettled([completion, ...tails]);
        await drainage;
        await parent.drain();
      }
    },
  );

  it("does not begin setup through a captured closed parent", async () => {
    const parent = new AsyncWorkScope();
    registerIsolatedHarness({
      runIsolatedCompletionV2: vi.fn(async () => reply("done")),
    });
    const invoke = parent.run(() => AsyncLocalStorage.bind(() => complete()));
    await parent.drain();
    await expect(invoke()).rejects.toThrow("Async work scope is closed");
    expect(mocks.acquireAgentRunPreparedModelRuntime).not.toHaveBeenCalled();
  });
});
