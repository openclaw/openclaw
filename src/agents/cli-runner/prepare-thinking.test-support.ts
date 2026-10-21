import { expect, it, vi } from "vitest";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { createCliRunnerPrepareFixture } from "../cli-runner.test-helpers.js";
import { setCliRunnerPrepareTestDeps } from "./prepare.test-support.js";
import type { RunCliAgentParams } from "./types.js";

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
  const base = { provider: "claude-cli", model: "claude-sonnet-4-5" };
  async function prepare(
    expected: string,
    overrides: Partial<RunCliAgentParams> = {},
    modelProvider?: string,
  ) {
    const prepareExecution = vi.fn(async () => undefined);
    setBackend({ prepareExecution, modelProvider });
    const context = await getFixture().prepare({
      ...base,
      thinkLevel: "ultra",
      ...overrides,
    });
    expect(context.providerThinkingLevel).toBe(expected);
    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({ thinkingLevel: expected }),
    );
    return context;
  }

  it("lowers Ultra to supported CLI effort and adds only current-turn guidance", async () => {
    const context = await prepare("high");
    expect(context.systemPrompt).not.toContain("Ultra active");
    expect([context.params.prompt, context.promptContext?.appendContext].join("\n")).toContain(
      "Ultra active for this turn",
    );
    const next = await getFixture().prepare({ ...base, thinkLevel: "high" });
    expect(next.params.sessionId).toBe(context.params.sessionId);
    expect(
      [next.systemPrompt, next.params.prompt, next.promptContext?.appendContext].join("\n"),
    ).not.toContain("Ultra active");
  });

  it("uses the model provider for uncataloged CLI Ultra with max effort", async () => {
    const modelProvider = "cli-thinking-policy-fixture";
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: modelProvider,
      source: "test",
      provider: {
        id: modelProvider,
        label: "CLI model owner",
        auth: [],
        resolveThinkingProfile: () => ({ levels: [{ id: "max" }], defaultLevel: "max" }),
      },
    });
    setActivePluginRegistry(registry);
    await prepare("max", { model: "uncataloged-model" }, modelProvider);
  });

  it.each([
    { mode: undefined, reasoning: false, thinkingLevelMap: undefined, expected: "off" },
    {
      mode: "replace" as const,
      reasoning: true,
      thinkingLevelMap: { high: null },
      expected: "medium",
    },
  ])("honors configured CLI Ultra effort $expected in mode $mode", async (testCase) => {
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
    const anthropic = {
      baseUrl: "https://example.invalid/v1",
      api: "anthropic-messages" as const,
      models: [
        {
          id: manifestEntry.id,
          name: manifestEntry.name,
          reasoning: testCase.reasoning,
          thinkingLevelMap: testCase.thinkingLevelMap,
          input: ["text" as const],
          contextWindow: 8192,
          maxTokens: 2048,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };
    await prepare(testCase.expected, {
      config: { models: { mode: testCase.mode, providers: { anthropic } } },
    });
    expect(manifestEntry.reasoning).toBe(true);
    expect(manifestEntry).not.toHaveProperty("thinkingLevelMap");
  });
}
