import { performance } from "node:perf_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isolatedReply as reply,
  isolatedCompletionMocks as mocks,
  runIsolatedCompletion,
  preparedModelRuntime,
  registerIsolatedHarness,
  releaseRuntimeLease,
  isolatedRequest,
  resetIsolatedCompletionTestState,
  nativeAuthPlan,
} from "../isolated-completion.test-support.js";
import { apiKey, authStore, oauth, token } from "../model-catalog-fixtures.test-support.js";
import type { PreparedAgentRuntimeAuthAttempt } from "../runtime-plan/types.js";

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

function registerReply(text: string) {
  const run = vi.fn(async () => reply(text));
  registerIsolatedHarness({ authBootstrap: "harness", runIsolatedCompletionV2: run });
  return run;
}
function prepareAttempts(...attempts: PreparedAgentRuntimeAuthAttempt[]) {
  mocks.prepareAgentRuntimeAuth.mockReturnValueOnce({ plan: attempts[0]!.plan, attempts });
}
function tokenProfiles(...names: string[]) {
  return Object.fromEntries(names.map((name) => ["openai:" + name, token(name)]));
}
const apiRoute = {
  ...nativeAuthPlan.modelRoute,
  api: "openai-responses" as const,
  baseUrl: "https://api.openai.com/v1",
  authRequirement: "api-key" as const,
};

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
        modelRoute: apiRoute,
      };
      mocks.ensureAuthProfileStore.mockReturnValueOnce(
        authStore({
          ...tokenProfiles("subscription"),
          "openai:key": apiKey("openai", "key"),
        }),
      );
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

  it.each([
    { next: "profile", retired: false, cooled: false },
    { next: "profile", retired: true, cooled: false },
    { next: "direct", retired: false, cooled: false },
    { next: "direct", retired: false, cooled: true },
  ] as const)(
    "keeps $next fallback core-owned (retired=$retired, cooled=$cooled)",
    async ({ next, retired, cooled }) => {
      let current = true;
      const expired = new Error("The completion owner retired.");
      const { modelRoute: _nativeRoute, ...identity } = nativeAuthPlan;
      const firstPlan = {
        ...(next === "profile" ? nativeAuthPlan : identity),
        forwardedAuthProfileId: "openai:first",
        forwardedAuthProfileSource: "auto" as const,
        forwardedAuthProfileCandidateIds:
          next === "profile" ? ["openai:first", "openai:backup"] : ["openai:first"],
      };
      mocks.ensureAuthProfileStore.mockReturnValueOnce(
        authStore(
          tokenProfiles(...(next === "profile" ? ["first", "backup"] : ["first"])),
          cooled ? { usageStats: { "openai:first": { cooldownUntil: Date.now() + 60_000 } } } : {},
        ),
      );
      prepareAttempts(
        { kind: "profile", plan: firstPlan, profileId: "openai:first" },
        next === "profile"
          ? {
              kind: "profile",
              profileId: "openai:backup",
              plan: {
                ...firstPlan,
                forwardedAuthProfileId: "openai:backup",
                forwardedAuthProfileCandidateIds: ["openai:backup"],
              },
            }
          : {
              kind: "direct",
              plan: { ...identity, modelRoute: apiRoute },
              allowAuthProfileFallback: false,
              requiresPriorProfileAttempt: true,
            },
      );
      const dispatch = vi
        .fn()
        .mockImplementationOnce(async () => {
          current = !retired;
          throw new Error("first profile unavailable");
        })
        .mockResolvedValueOnce(reply("fallback result"));
      registerIsolatedHarness({ authBootstrap: "harness", runIsolatedCompletionV2: dispatch });
      const pending = runIsolatedCompletion(
        isolatedRequest({
          assertCurrent() {
            if (!current) {
              throw expired;
            }
          },
        }),
      );
      if (cooled) {
        await expect(pending).rejects.toThrow("temporarily unavailable");
        expect(dispatch).not.toHaveBeenCalled();
        expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
      } else if (retired) {
        await expect(pending).rejects.toBe(expired);
        expect(dispatch).toHaveBeenCalledOnce();
      } else {
        await expect(pending).resolves.toMatchObject({ text: "fallback result" });
        expect(dispatch).toHaveBeenCalledTimes(2);
        if (next === "direct") {
          expect(mocks.prepareSimpleCompletionModel).toHaveBeenCalledOnce();
        } else {
          for (const [index, id] of ["openai:first", "openai:backup"].entries()) {
            const authorization = dispatch.mock.calls[index]![0].authorization;
            assert(authorization.owner === "harness", "expected harness authorization");
            expect(authorization.plan.forwardedAuthProfileId).toBe(id);
            expect(authorization.plan.forwardedAuthProfileCandidateIds).toEqual([id]);
            expect(Object.keys(authorization.authProfileStore.profiles)).toEqual([id]);
          }
          expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
        }
      }
      expect(releaseRuntimeLease).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { mode: "api-key", owner: "host", ...apiRoute },
    { mode: "subscription", owner: "harness", ...nativeAuthPlan.modelRoute },
  ] as const)("dispatches the real prepared $mode route to $owner authorization", async (route) => {
    const { prepareAgentRuntimeAuth } = await vi.importActual<
      typeof import("../runtime-plan/prepare-auth.js")
    >("../runtime-plan/prepare-auth.js");
    mocks.prepareAgentRuntimeAuth.mockImplementation((params) =>
      prepareAgentRuntimeAuth({ ...params, env: {} }),
    );
    const profileId = "openai:utility";
    mocks.ensureAuthProfileStore.mockReturnValue(
      authStore({
        [profileId]:
          route.mode === "api-key"
            ? apiKey("openai", "synthetic-api-key")
            : oauth("openai", Date.now() + 60_000),
      }),
    );
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
        runIsolatedCompletion(
          isolatedRequest({
            model: "gpt-5.5",
            authProfileId: profileId,
            outputTextPolicy: "strict-visible",
            streamParams: { maxTokens: 4_096, temperature: 0.2 },
          }),
        ),
      );
    } finally {
      await AsyncWorkScope.runWhenAllIdle(
        () => [parent],
        () => parent.drain(),
      );
    }

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
