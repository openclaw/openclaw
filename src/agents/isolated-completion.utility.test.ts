import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  isolatedAssistant,
  isolatedCompletionMocks as mocks,
  registerIsolatedHarness,
  resetIsolatedCompletionTestState,
  runIsolatedCompletion,
} from "./isolated-completion.test-support.js";

// Register the shared mocks before loading the real utility preparation owner.
const { prepareUtilityCompletionForAgent } = await import("./utility-completion.js");

beforeEach(resetIsolatedCompletionTestState);

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
            auth: {
              apiKey: "anthropic-test-key",
              source: "profile:anthropic:test",
              mode: "api-key",
            },
          }
        : { error: 'No API key found for provider "anthropic".' },
    );
    mocks.runCliAgent.mockResolvedValue({ payloads: [{ text: "Utility result" }] });
    const dispatch = vi.fn(async () => ({
      assistant: isolatedAssistant([{ type: "text", text: "Utility result" }]),
    }));
    registerIsolatedHarness({
      id: "openclaw",
      label: "OpenClaw",
      runIsolatedCompletionV2: dispatch,
    });
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

    if (auth) {
      expect(prepared).not.toHaveProperty("agentHarnessRuntimeOverride");
      await expect(runIsolatedCompletion(request)).resolves.toMatchObject({
        text: "Utility result",
      });
      expect(mocks.prepareSimpleCompletionModel).toHaveBeenCalledOnce();
      expect(mocks.prepareSimpleCompletionModel).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "anthropic", modelId: "claude-haiku-4-5" }),
        expect.anything(),
      );
      expect(dispatch).toHaveBeenCalledOnce();
      expect(mocks.runCliAgent).not.toHaveBeenCalled();
      return;
    }

    await expect(runIsolatedCompletion(request)).resolves.toMatchObject({
      text: "Utility result",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      owner: { kind: "cli", id: "claude-cli" },
    });
    expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(mocks.runCliAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude-cli",
        modelProvider: "anthropic",
        model: "claude-haiku-4-5",
        isolatedCompletion: true,
      }),
    );

    // Without the borrowed owner, the same credentialless request reproduces #138789.
    await expect(
      runIsolatedCompletion({ ...request, agentHarnessRuntimeOverride: undefined }),
    ).rejects.toThrow('No API key found for provider "anthropic"');
    expect(mocks.prepareSimpleCompletionModel).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    expect(mocks.runCliAgent).toHaveBeenCalledOnce();
  },
);
