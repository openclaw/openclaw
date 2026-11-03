import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import type { createCliRunnerPrepareFixture } from "../cli-runner.test-helpers.js";
import { setCliRunnerPrepareTestDeps } from "./prepare.test-support.js";

type CliContextBudgetTestCase = {
  name: string;
  provider: string;
  expectedContextTokens: number;
  model: string;
  modelAliases?: Record<string, string>;
};

/** Keep budget coverage on the full admitted preparation path and its shared fixture. */
export function registerCliModelContextPreparationTests({
  getFixture,
  createCliBackendConfig,
  setBackend,
}: {
  getFixture: () => ReturnType<typeof createCliRunnerPrepareFixture>;
  createCliBackendConfig: () => OpenClawConfig;
  setBackend: (params: {
    id?: string;
    command?: string;
    modelProvider?: string;
    pluginId?: string;
    prepareExecution?: CliBackendPlugin["prepareExecution"];
    modelAliases?: Record<string, string>;
  }) => void;
}) {
  it.each<CliContextBudgetTestCase>([
    {
      name: "a Claude CLI user alias",
      provider: "claude-cli",
      expectedContextTokens: 100_000,
      model: "large",
      modelAliases: { large: "claude-opus-4-7" },
    },
    {
      name: "a Claude CLI-native alias",
      provider: "claude-cli",
      expectedContextTokens: 100_000,
      model: "claude-opus-4-7",
      modelAliases: { "claude-opus-4-7": "deployment-large" },
    },
  ])("resolves canonical model budgets for $name", async (testCase) => {
    const prepareExecution = vi.fn(async () => undefined);
    const baseConfig = createCliBackendConfig();
    setBackend({
      id: testCase.provider,
      command: testCase.provider === "claude-cli" ? "claude" : testCase.provider,
      modelProvider: "fixture-anthropic",
      pluginId: "fixture-plugin",
      prepareExecution,
      modelAliases: testCase.modelAliases,
    });
    const context = await getFixture().prepare({
      provider: testCase.provider,
      model: testCase.model,
      config: {
        ...baseConfig,
        agents: baseConfig.agents,
        models: {
          providers: {
            "fixture-anthropic": {
              baseUrl: "https://api.anthropic.com",
              models: [
                {
                  id: "claude-opus-4-7",
                  name: "Claude Opus 4.7",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 200_000,
                  maxTokens: 8_192,
                  contextTokens: 100_000,
                },
              ],
            },
            "collision-provider": {
              baseUrl: "https://collision.invalid",
              models: [
                {
                  id: "large",
                  name: "Unrelated Large",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 32_000,
                  maxTokens: 4_096,
                  contextTokens: 32_000,
                },
              ],
            },
            "claude-cli": {
              baseUrl: "https://runtime.invalid",
              models: [
                {
                  id: "large",
                  name: "Configured Alias Source",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 200_000,
                  maxTokens: 8_192,
                  contextTokens: 200_000,
                },
              ],
            },
          },
        },
      } satisfies OpenClawConfig,
    });

    expect(context.backendResolved.modelProvider).toBe("fixture-anthropic");
    expect(context.contextWindowInfo?.tokens).toBe(testCase.expectedContextTokens);
    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({ contextTokenBudget: testCase.expectedContextTokens }),
    );
  });

  it.each([
    { name: "the session-selected 200k option", selection: "200k", expected: 200_000 },
    {
      name: "the declared default option when unselected",
      selection: undefined,
      expected: 1_000_000,
    },
  ])("caps the context budget with $name from catalog contextWindows", async (testCase) => {
    const prepareExecution = vi.fn(async () => undefined);
    setBackend({ prepareExecution });
    setCliRunnerPrepareTestDeps({
      loadManifestModelCatalog: vi.fn(() => [
        {
          id: "claude-fable-5",
          name: "Claude Fable 5",
          provider: "anthropic",
          contextWindow: 1_000_000,
          contextWindows: [
            { id: "200k", label: "200K", contextWindow: 200_000 },
            { id: "1m", label: "1M", contextWindow: 1_000_000 },
          ],
          contextWindowDefault: "1m",
        },
      ]),
    });

    const context = await getFixture().prepare({
      provider: "claude-cli",
      model: "claude-fable-5",
      config: {},
      // The run owner carries the selection as a prepared fact; a session entry
      // alone must not drive it (reply-path regression: selection dropped when
      // prepare read sessionEntry directly).
      ...(testCase.selection ? { contextWindow: testCase.selection } : {}),
      sessionEntry: {
        sessionId: "cli-session",
        updatedAt: 0,
        ...(testCase.selection ? {} : { contextWindow: "200k" }),
      },
    });

    expect(context.contextWindowInfo?.tokens).toBe(testCase.expected);
    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({ contextTokenBudget: testCase.expected }),
    );
  });
}
