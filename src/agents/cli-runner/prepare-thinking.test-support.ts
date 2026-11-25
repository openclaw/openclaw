import { expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { createCliRunnerPrepareFixture } from "../cli-runner.test-helpers.js";
import type { RunCliAgentParams } from "./types.js";

type Params = Partial<RunCliAgentParams>;
export function registerCliThinkingPreparationTests({
  getFixture,
  setBackend,
}: {
  getFixture: () => ReturnType<typeof createCliRunnerPrepareFixture>;
  setBackend: (params: { modelProvider?: string }) => void;
}) {
  const base = { provider: "claude-cli", model: "claude-sonnet-4-5" };
  async function prepare(expected: string, overrides: Params = {}, modelProvider?: string) {
    setBackend({ modelProvider });
    const turn = await getFixture().prepare({ ...base, thinkLevel: "ultra", ...overrides });
    expect(turn.providerThinkingLevel).toBe(expected);
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
}
