import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isolatedAssistant,
  isolatedCompletionMocks as mocks,
  runIsolatedCompletion,
  registerIsolatedHarness,
  isolatedRequest,
  resetIsolatedCompletionTestState,
} from "./isolated-completion.test-support.js";

beforeEach(resetIsolatedCompletionTestState);

describe("local development isolated completion policy", () => {
  it("refuses local development primary completion before runtime or auth admission", async () => {
    await expect(
      runIsolatedCompletion({
        ...isolatedRequest(),
        config: {
          agents: {
            defaults: {
              localDevUtilityOnly: true,
              utilityModel: "copilot/gpt-6.1-sol",
              model: "autodev/gpt-56-reasoning-sol",
            },
          },
        },
        provider: "autodev",
        model: "gpt-56-reasoning-sol",
      }),
    ).rejects.toThrow("Local development isolated completion requires");
    expect(mocks.acquireAgentRunPreparedModelRuntime).not.toHaveBeenCalled();
    expect(mocks.prepareAgentRuntimeAuth).not.toHaveBeenCalled();
    expect(mocks.ensureAuthProfileStore).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "openai/gpt-test@other"])(
    "refuses an unconfigured or differently credentialed local utility (%s)",
    async (utilityModel) => {
      await expect(
        runIsolatedCompletion({
          ...isolatedRequest(),
          config: { agents: { defaults: { localDevUtilityOnly: true, utilityModel } } },
        }),
      ).rejects.toThrow("Local development isolated completion requires");
      expect(mocks.acquireAgentRunPreparedModelRuntime).not.toHaveBeenCalled();
    },
  );

  it("retains the explicitly selected utility completion in local development", async () => {
    const resolution = await mocks.resolveModelAsync();
    mocks.resolveModelAsync.mockResolvedValue({
      ...resolution,
      logicalRef: { provider: "openai", model: "gpt-test" },
    });
    const dispatch = vi.fn(async () => ({
      assistant: isolatedAssistant([{ type: "text", text: "Local utility label" }]),
    }));
    registerIsolatedHarness({ authBootstrap: "harness", runIsolatedCompletionV2: dispatch });
    await expect(
      runIsolatedCompletion({
        ...isolatedRequest(),
        config: {
          agents: {
            defaults: { localDevUtilityOnly: true, utilityModel: "openai/gpt-test" },
          },
        },
      }),
    ).resolves.toMatchObject({ text: "Local utility label" });
    expect(dispatch).toHaveBeenCalledOnce();
  });
});
