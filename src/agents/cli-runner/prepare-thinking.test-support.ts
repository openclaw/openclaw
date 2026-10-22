import { expect, it, vi } from "vitest";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { createCliRunnerPrepareFixture } from "../cli-runner.test-helpers.js";
import { setCliRunnerPrepareTestDeps } from "./prepare.test-support.js";
import type { RunCliAgentParams } from "./types.js";

type Params = Partial<RunCliAgentParams>;
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
  async function prepare(expected: string, overrides: Params = {}, modelProvider?: string) {
    const prepareExecution = vi.fn(async () => undefined);
    setBackend({ prepareExecution, modelProvider });
    const turn = await getFixture().prepare({ ...base, thinkLevel: "ultra", ...overrides });
    expect(turn.providerThinkingLevel).toBe(expected);
    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({ thinkingLevel: expected }),
    );
    return turn;
  }

  it("lowers Ultra to supported CLI effort and adds only current-turn guidance", async () => {
    const turn = await prepare("high");
    expect(turn.systemPrompt).not.toContain("Ultra active");
    expect([turn.params.prompt, turn.promptContext?.appendContext].join("\n")).toContain(
      "Ultra active for this turn",
    );
    const next = await getFixture().prepare({ ...base, thinkLevel: "high" });
    expect(next.params.sessionId).toBe(turn.params.sessionId);
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
    [undefined, false, undefined, "off"],
    ["replace", true, { high: null }, "medium"],
  ] as const)(
    "honors configured CLI Ultra effort in mode %s",
    async (mode, reasoning, thinkingLevelMap, expected) => {
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
      const model = {
        id: manifestEntry.id,
        name: manifestEntry.name,
        reasoning,
        thinkingLevelMap,
        input: ["text" as const],
        contextWindow: 8192,
        maxTokens: 2048,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      const anthropic = {
        baseUrl: "https://example.invalid/v1",
        api: "anthropic-messages" as const,
        models: [model],
      };
      await prepare(expected, {
        config: { models: { mode, providers: { anthropic } } },
      });
      expect(manifestEntry.reasoning).toBe(true);
      expect(manifestEntry).not.toHaveProperty("thinkingLevelMap");
    },
  );
}
