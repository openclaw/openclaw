import { expect, it, vi } from "vitest";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { createCliRunnerPrepareFixture } from "../cli-runner.test-helpers.js";
import { setCliRunnerPrepareTestDeps } from "./prepare.test-support.js";

/** Runs normal and Ultra thinking through the same admitted CLI preparation fixture as normal turns. */
export function registerCliThinkingPreparationTests({
  getFixture,
  setBackend,
}: {
  getFixture: () => ReturnType<typeof createCliRunnerPrepareFixture>;
  setBackend: (params: {
    prepareExecution: CliBackendPlugin["prepareExecution"];
    modelProvider?: string;
  }) => void;
}) {
  it.each(["high", "off"] as const)(
    "passes %s thinking through the CLI backend execution seam",
    async (thinkLevel) => {
      const prepareExecution = vi.fn(async () => undefined);
      setBackend({ prepareExecution });

      await getFixture().prepare({ provider: "claude-cli", thinkLevel });

      expect(prepareExecution).toHaveBeenCalledWith(
        expect.objectContaining({ thinkingLevel: thinkLevel }),
      );
    },
  );

  it("lowers Ultra to supported CLI effort and adds only current-turn guidance", async () => {
    const prepareExecution = vi.fn(async () => undefined);
    setBackend({ prepareExecution });
    const context = await getFixture().prepare({
      provider: "claude-cli",
      model: "claude-sonnet-4-5",
      thinkLevel: "ultra",
    });
    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({ thinkingLevel: "high" }),
    );
    expect(context.providerThinkingLevel).toBe("high");
    expect(context.systemPrompt).not.toContain("Ultra active");
    expect([context.params.prompt, context.promptContext?.appendContext].join("\n")).toContain(
      "Ultra active for this turn",
    );
    const nextContext = await getFixture().prepare({
      provider: "claude-cli",
      model: "claude-sonnet-4-5",
      thinkLevel: "high",
    });
    expect(nextContext.params.sessionId).toBe(context.params.sessionId);
    expect(
      [
        nextContext.systemPrompt,
        nextContext.params.prompt,
        nextContext.promptContext?.appendContext,
      ].join("\n"),
    ).not.toContain("Ultra active");
  });

  it.each(["max", "adaptive"] as const)(
    "uses the model provider for uncataloged CLI Ultra with %s effort",
    async (level) => {
      const modelProvider = "cli-thinking-policy-fixture";
      const registry = createEmptyPluginRegistry();
      registry.providers.push({
        pluginId: modelProvider,
        source: "test",
        provider: {
          id: modelProvider,
          label: "CLI model owner",
          auth: [],
          resolveThinkingProfile: () => ({ levels: [{ id: level }], defaultLevel: level }),
        },
      });
      setActivePluginRegistry(registry);
      const prepareExecution = vi.fn(async () => undefined);
      setBackend({ prepareExecution, modelProvider });
      const context = await getFixture().prepare({
        provider: "claude-cli",
        model: "uncataloged-model",
        thinkLevel: "ultra",
      });
      expect(context.providerThinkingLevel).toBe(level);
      expect(prepareExecution).toHaveBeenCalledWith(
        expect.objectContaining({ thinkingLevel: level }),
      );
    },
  );

  it.each(
    ([undefined, "merge", "replace"] as const).flatMap((mode) => [
      { mode, reasoning: false, thinkingLevelMap: undefined, expected: "off" },
      { mode, reasoning: true, thinkingLevelMap: { high: null }, expected: "medium" },
    ]),
  )("honors configured CLI Ultra effort $expected in mode $mode", async (testCase) => {
    const prepareExecution = vi.fn(async () => undefined);
    setBackend({ prepareExecution });
    const manifestEntry = {
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      provider: "anthropic",
      api: "anthropic-messages",
      reasoning: true,
    };
    setCliRunnerPrepareTestDeps({
      loadManifestModelCatalog: vi.fn(() => [manifestEntry]),
    });
    const context = await getFixture().prepare({
      provider: "claude-cli",
      model: "claude-sonnet-4-5",
      config: {
        models: {
          mode: testCase.mode,
          providers: {
            anthropic: {
              baseUrl: "https://example.invalid/v1",
              api: "anthropic-messages",
              models: [
                {
                  id: manifestEntry.id,
                  name: manifestEntry.name,
                  reasoning: testCase.reasoning,
                  thinkingLevelMap: testCase.thinkingLevelMap,
                  input: ["text"],
                  contextWindow: 8192,
                  maxTokens: 2048,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      },
      thinkLevel: "ultra",
    });
    expect(context.providerThinkingLevel).toBe(testCase.expected);
    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({ thinkingLevel: testCase.expected }),
    );
    expect(manifestEntry.reasoning).toBe(true);
    expect(manifestEntry).not.toHaveProperty("thinkingLevelMap");
  });
}
