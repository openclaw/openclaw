import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunDelegatedAuthority } from "../infra/agent-run-registry.js";
import type { AdmittedRunContext } from "./admitted-run-context.js";
import {
  isolatedAssistant,
  nativeAuthPlan,
  isolatedCompletionMocks as mocks,
  runIsolatedCompletion,
  preparedModelRuntime,
  registerIsolatedHarness,
  releaseRuntimeLease,
  isolatedRequest,
  resetIsolatedCompletionTestState,
  type IsolatedCliRunParams,
} from "./isolated-completion.test-support.js";
import type * as RuntimeAuth from "./runtime-plan/prepare-auth.js";

// The shared fixture must register mocks before other runtime modules load.
const { createDeferred } = await import("../../test/helpers/promise.js");
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

beforeEach(resetIsolatedCompletionTestState);

describe("runIsolatedCompletion", () => {
  function prepareQuotaProfiles() {
    const profileIds = ["openai:first", "openai:backup"];
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: Object.fromEntries(
        profileIds.map((id) => [id, { type: "token", provider: "openai", token: id }]),
      ),
    });
    mocks.prepareAgentRuntimeAuth.mockReturnValue({
      plan: nativeAuthPlan,
      attempts: profileIds.map((profileId) => ({
        kind: "profile",
        profileId,
        plan: { ...nativeAuthPlan, forwardedAuthProfileId: profileId },
      })),
    });
  }

  it.each([
    "429 Too many requests",
    "You have hit your ChatGPT usage limit. Try again in 120 minutes.",
    "Your credit balance is too low to access the API.",
  ])("rotates prepared profiles after returned quota errors: %s", async (errorMessage) => {
    prepareQuotaProfiles();
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({ assistant: { ...isolatedAssistant([], "error"), errorMessage } })
      .mockResolvedValueOnce({
        assistant: isolatedAssistant([{ type: "text", text: "recovered" }]),
      });
    registerIsolatedHarness({ authBootstrap: "harness", runIsolatedCompletionV2: dispatch });

    await expect(runIsolatedCompletion(isolatedRequest())).resolves.toMatchObject({
      text: "recovered",
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(
      dispatch.mock.calls.map(([params]) => params.authorization.plan.forwardedAuthProfileId),
    ).toEqual(["openai:first", "openai:backup"]);
    expect(releaseRuntimeLease).toHaveBeenCalledOnce();
  });

  it("preserves the first quota cause when every prepared profile is exhausted", async () => {
    prepareQuotaProfiles();
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({
        assistant: {
          ...isolatedAssistant([], "error"),
          errorMessage: "429 Too many requests. Retry after 90 seconds.",
        },
      })
      .mockResolvedValueOnce({
        assistant: {
          ...isolatedAssistant([], "error"),
          errorMessage: "429 Too many requests. Retry after 120 seconds.",
        },
      });
    registerIsolatedHarness({ authBootstrap: "harness", runIsolatedCompletionV2: dispatch });
    const error = await runIsolatedCompletion(isolatedRequest()).catch(
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ code: "output-rejected", cause: { retryAfterMs: 90_000 } });
    expect(resolveModelFallbackError(error)).toMatchObject({
      kind: "failover",
      error: { reason: "rate_limit" },
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not broaden an explicitly selected profile after a returned quota error", async () => {
    prepareQuotaProfiles();
    const { prepareAgentRuntimeAuth } = await vi.importActual<typeof RuntimeAuth>(
      "./runtime-plan/prepare-auth.js",
    );
    mocks.prepareAgentRuntimeAuth.mockImplementationOnce(prepareAgentRuntimeAuth);
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({
        assistant: { ...isolatedAssistant([], "error"), errorMessage: "429 Too many requests" },
      })
      .mockResolvedValueOnce({
        assistant: isolatedAssistant([{ type: "text", text: "unauthorized backup result" }]),
      });
    registerIsolatedHarness({ authBootstrap: "harness", runIsolatedCompletionV2: dispatch });
    await expect(
      runIsolatedCompletion({ ...isolatedRequest(), authProfileId: "openai:first" }),
    ).rejects.toMatchObject({ code: "output-rejected" });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it.each([400, 1_000])(
    "shares the request timeout after a quota attempt consumes %s ms",
    async (elapsedMs) => {
      prepareQuotaProfiles();
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const dispatch = vi
        .fn()
        .mockImplementationOnce(async () => {
          now.mockReturnValue(1_000 + elapsedMs);
          return {
            assistant: { ...isolatedAssistant([], "error"), errorMessage: "429 Too many requests" },
          };
        })
        .mockResolvedValueOnce({
          assistant: isolatedAssistant([{ type: "text", text: "recovered" }]),
        });
      registerIsolatedHarness({ authBootstrap: "harness", runIsolatedCompletionV2: dispatch });
      try {
        const completion = runIsolatedCompletion(isolatedRequest());
        if (elapsedMs === 1_000) {
          await expect(completion).rejects.toThrow("timed out");
          expect(dispatch).toHaveBeenCalledOnce();
        } else {
          await expect(completion).resolves.toMatchObject({ text: "recovered" });
          expect(dispatch).toHaveBeenNthCalledWith(2, expect.objectContaining({ timeoutMs: 600 }));
        }
      } finally {
        now.mockRestore();
      }
    },
  );

  it.each(["terminal", "tool", "aborted", "authorization", "unknown"] as const)(
    "does not rotate prepared profiles after %s output",
    async (kind) => {
      prepareQuotaProfiles();
      const assistant = isolatedAssistant(
        kind === "tool"
          ? [{ type: "toolCall", id: "call-1", name: "update_plan", arguments: {} }]
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
      await expect(runIsolatedCompletion(isolatedRequest())).rejects.toMatchObject({
        code: "output-rejected",
      });
      expect(dispatch).toHaveBeenCalledOnce();
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
        return {
          assistant: { ...isolatedAssistant([], "error"), errorMessage: "429 Too many requests" },
        };
      });
      registerIsolatedHarness({ authBootstrap: "harness", runIsolatedCompletionV2: dispatch });
      await expect(
        runIsolatedCompletion({
          ...isolatedRequest(),
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

  it.each(["v1", "v2"] as const)(
    "rejects a retained %s dispatch callback after isolated completion closes",
    async (version) => {
      const dispatch = vi.fn();
      let dispatchLater: (() => void) | undefined;
      const run = async (params: { assertCurrent?: () => void }) => {
        dispatchLater = () => {
          params.assertCurrent?.();
          dispatch();
        };
        return { assistant: isolatedAssistant([{ type: "text", text: "done" }]) };
      };
      registerIsolatedHarness(
        version === "v1" ? { runIsolatedCompletion: run } : { runIsolatedCompletionV2: run },
      );
      await runIsolatedCompletion(isolatedRequest());
      if (!dispatchLater) {
        throw new Error("The harness did not receive its dispatch callback.");
      }
      expect(dispatchLater).toThrow("Isolated completion has ended");
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["runtime", "v2"],
    ["plugin", "v2"],
    ["host auth", "v1"],
    ["host auth", "v2"],
  ] as const)("rejects retired authority after %s preparation for %s", async (stage, version) => {
    const entered = createDeferred();
    const release = createDeferred();
    const expired = new Error("The completion owner retired.");
    let current = true;
    const dispatch = vi.fn(async () => ({
      assistant: isolatedAssistant([{ type: "text", text: "done" }]),
    }));
    registerIsolatedHarness(
      version === "v1"
        ? { runIsolatedCompletion: dispatch }
        : { runIsolatedCompletionV2: dispatch },
    );
    const pause = async () => {
      entered.resolve();
      await release.promise;
    };
    if (stage === "runtime") {
      mocks.acquireAgentRunPreparedModelRuntime.mockImplementationOnce(async () => {
        await pause();
        return { snapshot: preparedModelRuntime, [Symbol.asyncDispose]: releaseRuntimeLease };
      });
    } else if (stage === "plugin") {
      mocks.ensureSelectedAgentHarnessPlugin.mockImplementationOnce(pause);
    } else {
      mocks.prepareSimpleCompletionModel.mockImplementationOnce(async () => {
        await pause();
        return {
          model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
          auth: { apiKey: "synthetic-key", mode: "api-key", source: "test" },
        };
      });
    }
    const completion = runIsolatedCompletion({
      ...isolatedRequest(),
      assertCurrent() {
        if (!current) {
          throw expired;
        }
      },
    });
    try {
      await Promise.race([
        entered.promise,
        completion.then(() => {
          throw new Error("Completion settled before the preparation barrier.");
        }),
      ]);
      current = false;
      release.resolve();
      await expect(completion).rejects.toBe(expired);
      expect(dispatch).not.toHaveBeenCalled();
      expect(releaseRuntimeLease).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
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
        runIsolatedCompletion({
          ...isolatedRequest(),
          provider,
          model: "claude-test",
          agentHarnessRuntimeOverride: undefined,
        }),
      ).resolves.toMatchObject({
        text: "Utility result",
        provider: "anthropic",
        owner: { kind: "cli", id: "claude-cli" },
      });
      expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
      expect(mocks.runCliAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "claude-cli",
          modelProvider: "anthropic",
          isolatedCompletion: true,
          cliToolAvailability: { native: [], openClaw: [] },
        }),
      );
    },
  );

  it("forwards the native output schema to a V2 harness", async () => {
    const dispatch = vi.fn(async (_params: unknown) => ({
      assistant: isolatedAssistant([{ type: "text", text: '{"ok":true}' }]),
    }));
    registerIsolatedHarness({ runIsolatedCompletionV2: dispatch });
    const outputSchema = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    };

    await runIsolatedCompletion({ ...isolatedRequest(), outputSchema });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ outputSchema }));
  });

  it.each([false, true])(
    "captures call-owned choices and authority before admission (retired: %s)",
    async (retired) => {
      const entered = createDeferred();
      const release = createDeferred();
      const expired = new Error("The original completion owner retired.");
      let current = true;
      const dispatch = vi.fn(async () => ({
        assistant: isolatedAssistant([{ type: "text", text: "done" }]),
      }));
      registerIsolatedHarness({ runIsolatedCompletionV2: dispatch });
      mocks.acquireAgentRunPreparedModelRuntime.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { snapshot: preparedModelRuntime, [Symbol.asyncDispose]: releaseRuntimeLease };
      });
      const mutableRequest = {
        ...isolatedRequest(),
        authProfileId: "openai:original",
        streamParams: { maxTokens: 21, temperature: 0.1 },
        assertCurrent() {
          if (!current) {
            throw expired;
          }
        },
      };
      const completion = runIsolatedCompletion(mutableRequest);
      try {
        await entered.promise;
        mutableRequest.model = "changed-model";
        mutableRequest.authProfileId = "openai:changed";
        mutableRequest.streamParams.maxTokens = 84;
        mutableRequest.streamParams.temperature = 0.9;
        mutableRequest.agentHarnessRuntimeOverride = "changed-runtime";
        mutableRequest.assertCurrent = () => {};
        current = !retired;
        release.resolve();

        if (retired) {
          await expect(completion).rejects.toBe(expired);
          expect(dispatch).not.toHaveBeenCalled();
          expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
        } else {
          await expect(completion).resolves.toMatchObject({ text: "done" });
          expect(mocks.prepareSimpleCompletionModel).toHaveBeenCalledWith(
            expect.objectContaining({ modelId: "gpt-test", profileId: "openai:original" }),
            expect.any(Function),
          );
          expect(dispatch).toHaveBeenCalledOnce();
          expect(dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ streamParams: { maxTokens: 21, temperature: 0.1 } }),
          );
        }
        expect(releaseRuntimeLease).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await Promise.allSettled([completion]);
      }
    },
  );

  it.each(["host", "cli"])(
    "uses admitted config and directories for a newly owned %s completion",
    async (owner) => {
      const config = { agents: { defaults: { workspace: "/tmp/admitted-workspace" } } };
      Object.assign(preparedModelRuntime, {
        config,
        agentDir: "/tmp/admitted-agent",
        workspaceDir: "/tmp/admitted-workspace",
      });
      if (owner === "cli") {
        mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
        mocks.runCliAgent.mockResolvedValue({ payloads: [{ text: "done" }] });
      } else {
        registerIsolatedHarness({
          runIsolatedCompletionV2: async () => ({
            assistant: isolatedAssistant([{ type: "text", text: "done" }]),
          }),
        });
      }

      await expect(runIsolatedCompletion(isolatedRequest())).resolves.toMatchObject({
        text: "done",
      });

      const admitted = {
        config,
        agentDir: "/tmp/admitted-agent",
        workspaceDir: "/tmp/admitted-workspace",
      };
      expect(mocks.ensureSelectedAgentHarnessPlugin).toHaveBeenCalledWith(
        expect.objectContaining(admitted),
      );
      if (owner === "cli") {
        expect(mocks.runCliAgent).toHaveBeenCalledWith(expect.objectContaining(admitted));
      } else {
        expect(mocks.prepareSimpleCompletionModel).toHaveBeenCalledWith(
          expect.objectContaining({
            cfg: config,
            agentDir: admitted.agentDir,
            workspaceDir: admitted.workspaceDir,
            provider: "openai",
            modelId: "gpt-test",
          }),
          expect.any(Function),
        );
      }
      expect(releaseRuntimeLease).toHaveBeenCalledOnce();
    },
  );

  it("passes one prepared route to the selected harness and returns text", async () => {
    const runIsolatedCompletionHarness = vi.fn(async () => ({
      assistant: isolatedAssistant([{ type: "text", text: '{"ok":true}' }]),
    }));
    registerIsolatedHarness({
      runIsolatedCompletion: runIsolatedCompletionHarness,
    });

    await expect(runIsolatedCompletion(isolatedRequest())).resolves.toEqual({
      text: '{"ok":true}',
      provider: "openai",
      model: "gpt-test",
      owner: { kind: "harness", id: "codex" },
      usage: expect.objectContaining({ input: 1, output: 1, totalTokens: 2 }),
    });
    expect(mocks.prepareSimpleCompletionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: undefined,
        bindAuthOwner: true,
        preparedModelRuntime,
        workspaceDir: "/tmp/workspace",
      }),
      expect.any(Function),
    );
    expect(mocks.acquireAgentRunPreparedModelRuntime).toHaveBeenCalledOnce();
    expect(releaseRuntimeLease).toHaveBeenCalledOnce();
    expect(runIsolatedCompletionHarness).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-test",
        sourceAuthFingerprint: "fingerprint",
        systemPrompt: "Return JSON.",
        prompt: "Do the task.",
      }),
    );
  });

  it.each(["v1", "v2"] as const)(
    "unwraps prepared credentials at the external %s harness boundary",
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
      const runIsolatedCompletionHarness = vi.fn(async () => ({
        assistant: isolatedAssistant([{ type: "text", text: "done" }]),
      }));
      registerIsolatedHarness({
        id: "copilot",
        label: "Copilot",
        ...(version === "v1"
          ? { runIsolatedCompletion: runIsolatedCompletionHarness }
          : { runIsolatedCompletionV2: runIsolatedCompletionHarness }),
      });

      await runIsolatedCompletion({
        ...isolatedRequest(),
        provider: "github-copilot",
        agentHarnessRuntimeOverride: "copilot",
      });

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

  it("returns the provider and model identity reported by the harness", async () => {
    registerIsolatedHarness({
      runIsolatedCompletion: vi.fn(async () => ({
        assistant: {
          ...isolatedAssistant([{ type: "text", text: "done" }]),
          provider: "openai",
          model: "gpt-5.6-sol-actual",
        },
      })),
    });

    await expect(runIsolatedCompletion(isolatedRequest())).resolves.toEqual({
      text: "done",
      provider: "openai",
      model: "gpt-5.6-sol-actual",
      owner: { kind: "harness", id: "codex" },
      usage: expect.objectContaining({ input: 1, output: 1, totalTokens: 2 }),
    });
  });

  it.each([undefined, "claude-cli"])(
    "rejects a non-adopting explicit harness despite CLI candidate %s",
    async (cliCandidate) => {
      mocks.resolveCliRuntimeExecutionProvider.mockReturnValue(cliCandidate);
      registerIsolatedHarness({ id: "external", label: "External" });
      await expect(
        runIsolatedCompletion({ ...isolatedRequest(), agentHarnessRuntimeOverride: "external" }),
      ).rejects.toThrow("does not support isolated completion");
      expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
      expect(mocks.runCliAgent).not.toHaveBeenCalled();
    },
  );

  it("rejects tool-shaped harness output", async () => {
    registerIsolatedHarness({
      runIsolatedCompletion: vi.fn(async () => ({
        assistant: isolatedAssistant([
          { type: "toolCall", id: "call-1", name: "update_plan", arguments: {} },
        ]),
      })),
    });

    await expect(runIsolatedCompletion(isolatedRequest())).rejects.toMatchObject({
      code: "output-rejected",
      message: expect.stringContaining("returned a tool call"),
    });
  });

  it.each(["error", "aborted"] as const)(
    "rejects %s harness output before usage reaches the runtime finalizer",
    async (stopReason) => {
      registerIsolatedHarness({
        runIsolatedCompletion: vi.fn(async () => ({
          assistant: isolatedAssistant([{ type: "text", text: "partial" }], stopReason),
        })),
      });

      await expect(runIsolatedCompletion(isolatedRequest())).rejects.toMatchObject({
        code: "output-rejected",
        message: expect.stringContaining(`stop reason ${stopReason}`),
      });
    },
  );

  it.each([
    { errorMessage: "529 Overloaded", errorCode: undefined, reason: "overloaded" },
    {
      errorMessage: "429 Too many requests. Retry after 90 seconds.",
      errorCode: undefined,
      reason: "rate_limit",
      retryAfterMs: 90_000,
    },
    {
      errorMessage: "529 Overloaded after output started",
      errorCode: PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE,
      reason: undefined,
    },
  ])(
    "preserves retry classification without replaying terminal output: $errorMessage",
    async ({ errorMessage, errorCode, reason, retryAfterMs }) => {
      registerIsolatedHarness({
        runIsolatedCompletion: vi.fn(async () => ({
          assistant: {
            ...isolatedAssistant([], "error"),
            errorMessage,
            errorCode,
          },
        })),
      });
      const error = await runIsolatedCompletion(isolatedRequest()).catch(
        (failure: unknown) => failure,
      );
      expect(error).toMatchObject({ code: "output-rejected" });
      expect(resolveModelFallbackError(error)).toMatchObject(
        reason ? { kind: "failover", error: { reason } } : { kind: "unknown" },
      );
      if (retryAfterMs !== undefined) {
        expect(error).toMatchObject({ cause: { retryAfterMs } });
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

      const result = runIsolatedCompletion({
        ...isolatedRequest(),
        ...(strict ? { outputTextPolicy: "strict-visible" as const } : {}),
      });
      if (strict) {
        await expect(result).resolves.toMatchObject({ text: "" });
      } else {
        await expect(result).rejects.toMatchObject({
          code: "output-rejected",
          message: expect.stringContaining("empty output"),
        });
      }
      if (cli) {
        expect(mocks.runCliAgent).toHaveBeenCalledWith(
          expect.objectContaining({ outputTextPolicy: strict ? "strict-visible" : undefined }),
        );
      }
    },
  );

  it.each([undefined, { input: 8, output: 3, cacheRead: 2, total: 13 }])(
    "routes CLI owners through one empty-tool run with reported usage %j",
    async (usage) => {
      mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
      mocks.runCliAgent.mockResolvedValue({
        payloads: [{ text: '{"cli":true}' }],
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId: "cli-session",
            provider: "claude-cli",
            model: "claude-test",
            usage,
          },
        },
      });

      await expect(
        runIsolatedCompletion({
          ...isolatedRequest(),
          provider: "anthropic",
          model: "claude-test",
          agentHarnessRuntimeOverride: "claude-cli",
        }),
      ).resolves.toStrictEqual({
        text: '{"cli":true}',
        provider: "anthropic",
        model: "claude-test",
        owner: { kind: "cli", id: "claude-cli" },
        ...(usage ? { usage } : {}),
      });
      expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
      expect(mocks.runCliAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "claude-cli",
          modelProvider: "anthropic",
          authProfileId: undefined,
          executionMode: "side-question",
          isolatedCompletion: true,
          disableTools: true,
          cliToolAvailability: { native: [], openClaw: [] },
        }),
      );
    },
  );

  it("keeps concurrent CLI isolated completions independently admitted", async () => {
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

    const first = runIsolatedCompletion({ ...isolatedRequest(), prompt: "first" });
    let second: ReturnType<typeof runIsolatedCompletion> | undefined;
    try {
      await Promise.race([
        firstStarted.promise,
        first.then(() => {
          throw new Error("first isolated completion settled before reaching the barrier");
        }),
      ]);
      second = runIsolatedCompletion({ ...isolatedRequest(), prompt: "second" });
      await Promise.race([
        bothStarted.promise,
        Promise.all([first, second]).then(() => {
          throw new Error("isolated completions settled before reaching the barrier");
        }),
      ]);
      const firstCall = calls.find(({ params }) => params.prompt === "first");
      const secondCall = calls.find(({ params }) => params.prompt === "second");
      if (!firstCall || !secondCall) {
        throw new Error("expected both isolated completions to start");
      }
      expect(firstCall.params.runId).toBe(firstCall.params.sessionId);
      expect(secondCall.params.runId).toBe(secondCall.params.sessionId);
      expect(firstCall.params.runId).not.toBe(secondCall.params.runId);
      expect(firstCall.admitted.operationalRunInstance.runId).toBe(firstCall.params.runId);
      expect(secondCall.admitted.operationalRunInstance.runId).toBe(secondCall.params.runId);
      expect(validateAgentRunDelegatedAuthority(firstCall.authority)).toBe(true);
      expect(validateAgentRunDelegatedAuthority(secondCall.authority)).toBe(true);

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

  it("forwards one explicit auth profile unchanged to a CLI owner", async () => {
    mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
    mocks.runCliAgent.mockResolvedValue({ payloads: [{ text: "done" }] });

    await runIsolatedCompletion({
      ...isolatedRequest(),
      provider: "google",
      model: "gemini-test",
      authProfileId: "google:locked",
      agentHarnessRuntimeOverride: "google-gemini-cli",
    });

    expect(mocks.runCliAgent).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: "google:locked" }),
    );
  });

  it("reports the normalized model sent to a CLI owner", async () => {
    mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
    mocks.resolveCliBackendConfig.mockReturnValue({
      config: { command: "gemini", modelAliases: { flash: "gemini-3.1-flash-preview" } },
    });
    mocks.runCliAgent.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: { durationMs: 1 },
    });

    await expect(
      runIsolatedCompletion({
        ...isolatedRequest(),
        provider: "google",
        model: "flash",
        agentHarnessRuntimeOverride: "google-gemini-cli",
      }),
    ).resolves.toEqual({
      text: "done",
      provider: "google",
      model: "gemini-3.1-flash-preview",
      owner: { kind: "cli", id: "google-gemini-cli" },
    });
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
      if (stage === "acquisition") {
        mocks.acquireAgentRunPreparedModelRuntime.mockImplementationOnce(async () => {
          await pause();
          return { snapshot: preparedModelRuntime, [Symbol.asyncDispose]: releaseRuntimeLease };
        });
      } else {
        mocks.prepareSimpleCompletionModel.mockImplementationOnce(async () => {
          await pause();
          return {
            model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
            auth: { apiKey: "synthetic-key", mode: "api-key", source: "test" },
          };
        });
      }
      const dispatch = vi.fn(async () => ({
        assistant: isolatedAssistant([{ type: "text", text: "done" }]),
      }));
      registerIsolatedHarness({ runIsolatedCompletionV2: dispatch });
      const completion = withPluginRuntimeRegistryScope(callerRegistry, () =>
        parent.run(() =>
          runIsolatedCompletion({
            ...isolatedRequest(),
            abortSignal: caller.signal,
          }),
        ),
      );
      let drained = false;
      let drainage: Promise<void> | undefined;
      try {
        await Promise.race([
          entered.promise,
          completion.then(() => {
            throw new Error("Completion ended before setup entered");
          }),
        ]);
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
      runIsolatedCompletionV2: vi.fn(async () => ({
        assistant: isolatedAssistant([{ type: "text", text: "done" }]),
      })),
    });
    const invoke = parent.run(() =>
      AsyncLocalStorage.bind(() => runIsolatedCompletion(isolatedRequest())),
    );
    await parent.drain();
    await expect(invoke()).rejects.toThrow("Async work scope is closed");
    expect(mocks.acquireAgentRunPreparedModelRuntime).not.toHaveBeenCalled();
  });
});
