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
const { resolveIsolatedCompletionRuntime } = await import("./isolated-completion-route.js");

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
