import { performance } from "node:perf_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isolatedAssistant,
  isolatedCompletionMocks as mocks,
  runIsolatedCompletion,
  preparedModelRuntime,
  registerIsolatedHarness,
  releaseRuntimeLease,
  isolatedRequest,
  resetIsolatedCompletionTestState,
  nativeAuthPlan,
} from "../isolated-completion.test-support.js";
import type { PreparedAgentRuntimeAuthAttempt } from "../runtime-plan/prepare-auth.js";

const { createPluginMetadataSnapshot, makeRegistry } =
  await import("../../config/plugin-auto-enable.test-helpers.js");

const { AsyncWorkScope } = await import("../../shared/async-work-scope.js");

beforeEach(() => {
  resetIsolatedCompletionTestState();
  // Authorization routing must not consume its budget while CI schedules other workers.
  // isolated-completion.deadline.test.ts owns elapsed-time and expiry behavior.
  vi.spyOn(performance, "now").mockReturnValue(0);
});

afterEach(() => vi.restoreAllMocks());

const reply = (text: string) => ({ assistant: isolatedAssistant([{ type: "text", text }]) });
function registerReply(text: string) {
  const run = vi.fn(async () => reply(text));
  registerIsolatedHarness({ authBootstrap: "harness", runIsolatedCompletionV2: run });
  return run;
}
function prepareAttempts(...attempts: PreparedAgentRuntimeAuthAttempt[]) {
  mocks.prepareAgentRuntimeAuth.mockReturnValueOnce({ plan: attempts[0]!.plan, attempts });
}
function tokenProfiles(...names: string[]) {
  return Object.fromEntries(
    names.map((name) => [
      "openai:" + name,
      { type: "token" as const, provider: "openai", token: name },
    ]),
  );
}

describe("runIsolatedCompletion native authorization", () => {
  it.each(["profile", "dependent-direct"] as const)(
    "rejects a retired native route before dispatch (API sibling: %s)",
    async (apiSibling) => {
      const registry = makeRegistry([
        { id: "retirement-owner", channels: [], providers: ["openai"], origin: "bundled" },
      ]);
      Object.assign(expectDefined(registry.plugins[0], "retirement fixture owner"), {
        enabledByDefault: true,
        modelCatalog: {
          suppressions: [
            {
              provider: "openai",
              model: "gpt-test",
              retirement: {},
              when: { baseUrlHosts: ["chatgpt.com"] },
            },
          ],
        },
      });
      Object.assign(preparedModelRuntime, {
        metadataSnapshot: createPluginMetadataSnapshot({ manifestRegistry: registry }),
      });
      const subscriptionPlan = {
        ...nativeAuthPlan,
        forwardedAuthProfileId: "openai:subscription",
      };
      const apiPlan = {
        ...subscriptionPlan,
        forwardedAuthProfileId: "openai:key",
        modelRoute: {
          ...subscriptionPlan.modelRoute,
          api: "openai-responses" as const,
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key" as const,
        },
      };
      mocks.ensureAuthProfileStore.mockReturnValueOnce({
        version: 1,
        profiles: {
          ...tokenProfiles("subscription"),
          "openai:key": { type: "api_key", provider: "openai", key: "key" },
        },
      });
      mocks.resolveModelAsync.mockResolvedValueOnce({
        model: {
          provider: "openai",
          id: "gpt-test",
          api: "openai-chatgpt-responses",
          baseUrl: subscriptionPlan.modelRoute.baseUrl,
        },
      });
      prepareAttempts(
        { kind: "profile", plan: subscriptionPlan, profileId: "openai:subscription" },
        apiSibling === "profile"
          ? { kind: "profile", plan: apiPlan, profileId: "openai:key" }
          : {
              kind: "direct",
              plan: { ...apiPlan, forwardedAuthProfileId: undefined },
              allowAuthProfileFallback: false,
              requiresPriorProfileAttempt: true,
            },
      );
      const runIsolatedCompletionV2 = registerReply("API sibling reply");
      const pending = runIsolatedCompletion(isolatedRequest());
      if (apiSibling === "profile") {
        await expect(pending).resolves.toMatchObject({ text: "API sibling reply" });
        expect(runIsolatedCompletionV2).toHaveBeenCalledOnce();
        expect(runIsolatedCompletionV2).toHaveBeenCalledWith(
          expect.objectContaining({ authorization: expect.objectContaining({ owner: "host" }) }),
        );
        expect(mocks.prepareSimpleCompletionModel).toHaveBeenCalledWith(
          expect.objectContaining({ profileId: "openai:key" }),
          expect.any(Function),
        );
      } else {
        await expect(pending).rejects.toMatchObject({
          reason: "model_not_found",
          message: expect.stringContaining("openclaw doctor --fix"),
        });
        expect(runIsolatedCompletionV2).not.toHaveBeenCalled();
        expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
      }
      expect(releaseRuntimeLease).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])("keeps harness fallback core-owned (retired: %s)", async (retired) => {
    let current = true;
    const expired = new Error("The completion owner retired.");
    const firstPlan = {
      ...nativeAuthPlan,
      forwardedAuthProfileId: "openai:first",
      forwardedAuthProfileSource: "auto" as const,
      forwardedAuthProfileCandidateIds: ["openai:first", "openai:backup"],
    };
    const backupPlan = {
      ...firstPlan,
      forwardedAuthProfileId: "openai:backup",
      forwardedAuthProfileCandidateIds: ["openai:backup"],
    };
    mocks.ensureAuthProfileStore.mockReturnValueOnce({
      version: 1,
      profiles: tokenProfiles("first", "backup"),
    });
    prepareAttempts(
      { kind: "profile", plan: firstPlan, profileId: "openai:first" },
      { kind: "profile", plan: backupPlan, profileId: "openai:backup" },
    );
    const runIsolatedCompletionV2 = vi
      .fn()
      .mockImplementationOnce(async () => {
        current = !retired;
        throw new Error("first profile unavailable");
      })
      .mockResolvedValueOnce(reply("backup result"));
    registerIsolatedHarness({ authBootstrap: "harness", runIsolatedCompletionV2 });

    const completion = runIsolatedCompletion({
      ...isolatedRequest(),
      assertCurrent() {
        if (!current) {
          throw expired;
        }
      },
    });
    if (retired) {
      await expect(completion).rejects.toBe(expired);
      expect(runIsolatedCompletionV2).toHaveBeenCalledOnce();
      expect(releaseRuntimeLease).toHaveBeenCalledOnce();
      return;
    }
    await expect(completion).resolves.toMatchObject({
      text: "backup result",
    });
    expect(runIsolatedCompletionV2).toHaveBeenCalledTimes(2);
    for (const [index, id] of ["openai:first", "openai:backup"].entries()) {
      const authorization = runIsolatedCompletionV2.mock.calls[index]![0].authorization;
      expect(authorization.owner).toBe("harness");
      if (authorization.owner !== "harness") {
        throw new Error("expected harness authorization");
      }
      expect(authorization.plan.forwardedAuthProfileId).toBe(id);
      expect(authorization.plan.forwardedAuthProfileCandidateIds).toEqual([id]);
      expect(Object.keys(authorization.authProfileStore.profiles)).toEqual([id]);
    }
    expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "requires actual profile dispatch before direct auth (cooled: %s)",
    async (cooled) => {
      const profilePlan = {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        modelId: "gpt-test",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:first",
        forwardedAuthProfileSource: "auto" as const,
        forwardedAuthProfileCandidateIds: ["openai:first"],
      };
      const directPlan = {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        modelId: "gpt-test",
        harnessAuthProvider: "openai",
        modelRoute: {
          ...nativeAuthPlan.modelRoute,
          api: "openai-responses" as const,
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key" as const,
        },
      };
      mocks.ensureAuthProfileStore.mockReturnValueOnce({
        version: 1,
        profiles: tokenProfiles("first"),
        usageStats: cooled ? { "openai:first": { cooldownUntil: Date.now() + 60_000 } } : {},
      });
      prepareAttempts(
        { kind: "profile", plan: profilePlan, profileId: "openai:first" },
        {
          kind: "direct",
          plan: directPlan,
          allowAuthProfileFallback: false,
          requiresPriorProfileAttempt: true,
        },
      );
      const runIsolatedCompletionV2 = vi
        .fn()
        .mockRejectedValueOnce(new Error("profile unavailable"))
        .mockResolvedValueOnce(reply("direct result"));
      registerIsolatedHarness({ authBootstrap: "harness", runIsolatedCompletionV2 });

      if (cooled) {
        await expect(runIsolatedCompletion(isolatedRequest())).rejects.toThrow(
          "temporarily unavailable",
        );
        expect(runIsolatedCompletionV2).not.toHaveBeenCalled();
        expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
      } else {
        await expect(runIsolatedCompletion(isolatedRequest())).resolves.toMatchObject({
          text: "direct result",
        });
        expect(runIsolatedCompletionV2).toHaveBeenCalledTimes(2);
        expect(mocks.prepareSimpleCompletionModel).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    {
      mode: "api-key",
      owner: "host",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    },
    {
      mode: "subscription",
      owner: "harness",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    },
  ] as const)("dispatches the real prepared $mode route to $owner authorization", async (route) => {
    const { prepareAgentRuntimeAuth } = await vi.importActual<
      typeof import("../runtime-plan/prepare-auth.js")
    >("../runtime-plan/prepare-auth.js");
    mocks.prepareAgentRuntimeAuth.mockImplementation((params) =>
      prepareAgentRuntimeAuth({ ...params, env: {} }),
    );
    const profileId = "openai:utility";
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        [profileId]:
          route.mode === "api-key"
            ? { type: "api_key", provider: "openai", key: "synthetic-api-key" }
            : {
                type: "oauth",
                provider: "openai",
                access: "synthetic-access",
                refresh: "synthetic-refresh",
                expires: Date.now() + 60_000,
              },
      },
    });
    mocks.resolveModelAsync.mockResolvedValue({
      model: {
        provider: "openai",
        id: "gpt-5.5",
        api: route.api,
        baseUrl: route.baseUrl,
        maxTokens: 1_024,
      },
    });
    const runIsolatedCompletionV2 = registerReply("prepared route result");

    const parent = new AsyncWorkScope();
    try {
      await parent.run(() =>
        runIsolatedCompletion({
          ...isolatedRequest(),
          model: "gpt-5.5",
          authProfileId: profileId,
          outputTextPolicy: "strict-visible",
          streamParams: { maxTokens: 4_096, temperature: 0.2 },
        }),
      );
    } finally {
      await AsyncWorkScope.runWhenAllIdle(
        () => [parent],
        () => parent.drain(),
      );
    }

    expect(mocks.prepareAgentRuntimeAuth.mock.results[0]?.value.plan.modelRoute).toMatchObject({
      authRequirement: route.mode,
    });
    expect(mocks.prepareSimpleCompletionModel).toHaveBeenCalledTimes(
      route.owner === "host" ? 1 : 0,
    );
    expect(mocks.acquireAgentRunPreparedModelRuntime).toHaveBeenCalledOnce();
    expect(releaseRuntimeLease).toHaveBeenCalledOnce();
    expect(runIsolatedCompletionV2).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({ owner: route.owner }),
        outputTextPolicy: "strict-visible",
        streamParams: { maxTokens: route.owner === "harness" ? 1_024 : 4_096, temperature: 0.2 },
      }),
    );
  });
});
