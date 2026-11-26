import { beforeEach, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createOAuthRefreshCredential } from "./auth-profiles/credential-fixtures.test-support.js";
import type { AgentHarnessIsolatedCompletionParamsV2 } from "./harness/types.js";
import {
  isolatedAssistant,
  isolatedCompletionMocks as mocks,
  runIsolatedCompletion,
  preparedModelRuntime,
  registerIsolatedHarness,
  isolatedRequest,
  resetIsolatedCompletionTestState,
} from "./isolated-completion.test-support.js";
import type * as RuntimeAuth from "./runtime-plan/prepare-auth.js";

// The shared fixture must register mocks before other runtime modules load.
const { resolveIsolatedCompletionRuntime, resolveIsolatedCompletionAuthorizationOwner } =
  await import("./isolated-completion-route.js");

beforeEach(resetIsolatedCompletionTestState);

it.each([false, true])(
  "uses the admitted subscription route regardless of catalog order (reversed=%s)",
  async (reversed) => {
    // The shared fixture installs runtime mocks before the real planner is loaded.
    const { prepareAgentRuntimeAuth } = await vi.importActual<typeof RuntimeAuth>(
      "./runtime-plan/prepare-auth.js",
    );
    const platform = {
      provider: "openai",
      id: "gpt-test",
      name: "Test",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
    };
    const subscription = {
      ...platform,
      api: "openai-chatgpt-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    const snapshot = {
      entries: [platform],
      routeVariants: reversed ? [subscription, platform] : [platform, subscription],
    };
    Object.assign(preparedModelRuntime, { modelCatalog: snapshot });
    mocks.resolveModelAsync
      .mockResolvedValue({ model: subscription })
      .mockResolvedValueOnce({ model: platform });
    const store = {
      version: 1 as const,
      profiles: { "openai:subscription": createOAuthRefreshCredential() },
    };
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    mocks.prepareAgentRuntimeAuth.mockImplementation(prepareAgentRuntimeAuth);
    const dispatch = vi.fn(async (_params: AgentHarnessIsolatedCompletionParamsV2) => ({
      assistant: isolatedAssistant([{ type: "text", text: "Subscription result" }]),
    }));
    registerIsolatedHarness({
      authBootstrap: "harness",
      runIsolatedCompletionV2: dispatch,
      resolveIsolatedCompletionRuntime: ({ authorizationOwner }) =>
        authorizationOwner === "harness" ? "self" : "openclaw",
    });
    expect(
      await resolveIsolatedCompletionRuntime({
        ...isolatedRequest(),
        preparedAuth: {
          snapshot,
          preparedAuthStore: store,
          metadataSnapshot: createPluginMetadataSnapshotFixture(),
        },
      }),
    ).toMatchObject({ kind: "harness", id: "codex" });

    await expect(runIsolatedCompletion(isolatedRequest())).resolves.toMatchObject({
      text: "Subscription result",
      owner: { kind: "harness", id: "codex" },
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      authorization: {
        owner: "harness",
        plan: {
          forwardedAuthProfileId: "openai:subscription",
          modelRoute: { authRequirement: "subscription" },
        },
      },
    });
    await expect(
      runIsolatedCompletion({ ...isolatedRequest(), authProfileId: "openai:missing" }),
    ).rejects.toThrow('Selected auth profile "openai:missing" is unavailable.');
    expect(dispatch).toHaveBeenCalledOnce();
  },
);

it("retains OAuth ownership on an API destination without converting the grant to an API key", () => {
  const plan = {
    providerForAuth: "openai",
    authProfileProviderForAuth: "openai",
    harnessAuthProvider: "openai",
    modelRoute: {
      provider: "openai",
      modelId: "gpt-test",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      authRequirement: "api-key" as const,
      requestTransportOverrides: "none" as const,
    },
  };
  expect(
    resolveIsolatedCompletionAuthorizationOwner({
      ...plan,
      selectedAuthMode: "oauth",
      selectedAuthFlow: "chatgpt-token-sharing",
    }),
  ).toBe("harness");
  expect(
    resolveIsolatedCompletionAuthorizationOwner({ ...plan, selectedAuthMode: "api-key" }),
  ).toBe("host");
});

it.each([false, true])(
  "provider-scopes isolated preferences but retains exact requirements (required=%s)",
  async (required) => {
    const { prepareAgentRuntimeAuth } = await vi.importActual<typeof RuntimeAuth>(
      "./runtime-plan/prepare-auth.js",
    );
    mocks.prepareAgentRuntimeAuth.mockImplementation(prepareAgentRuntimeAuth);
    const store = {
      version: 1 as const,
      profiles: {
        "anthropic:delegated": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "synthetic",
        },
        "openai:default": createOAuthRefreshCredential(),
      },
    };
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    const dispatch = vi.fn(async () => ({
      assistant: isolatedAssistant([{ type: "text", text: "default account" }]),
    }));
    registerIsolatedHarness({
      authBootstrap: "harness",
      runIsolatedCompletionV2: dispatch,
      resolveIsolatedCompletionRuntime: () => "self",
    });
    const request = {
      ...isolatedRequest(),
      authProfileId: "anthropic:delegated",
      requiredAuthProfileId: required ? "anthropic:delegated" : undefined,
    };
    const model = {
      provider: "openai",
      id: "gpt-test",
      name: "Test",
      api: "openai-chatgpt-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    const runtime = await resolveIsolatedCompletionRuntime({
      ...request,
      preparedAuth: {
        preparedAuthStore: store,
        metadataSnapshot: createPluginMetadataSnapshotFixture(),
        snapshot: { entries: [model], routeVariants: [model] },
      },
    });
    if (required) {
      expect(runtime).toBeUndefined();
    } else {
      expect(runtime).toMatchObject({ kind: "harness", id: "codex" });
    }
    const completion = runIsolatedCompletion(request);
    if (required) {
      await expect(completion).rejects.toThrow();
      expect(dispatch).not.toHaveBeenCalled();
    } else {
      await expect(completion).resolves.toMatchObject({ text: "default account" });
      expect(dispatch).toHaveBeenCalledOnce();
    }
  },
);
