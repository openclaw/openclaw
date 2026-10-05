import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import type { AgentHarness } from "./harness/types.js";
import {
  isolatedAssistant,
  isolatedCompletionMocks as mocks,
  isolatedRequest,
  preparedModelRuntime,
  resetIsolatedCompletionTestState,
  runIsolatedCompletion,
} from "./isolated-completion.test-support.js";

const completeSimple = vi.hoisted(() => vi.fn());
// mock-isolation: Keep process-global provider and transport-host registration out of this isolated harness admission fixture.
vi.mock("../llm/stream.js", () => ({ completeSimple }));

const { resolveAgentHarnessSelectionDecision } = await vi.importActual<
  typeof import("./harness/selection-decision.js")
>("./harness/selection-decision.js");
const { createEmptyPluginRegistry } = await import("../plugins/registry-empty.js");
const { createCodexHarnessForTest } = await loadBundledPluginFacade<{
  createCodexHarnessForTest: () => Promise<AgentHarness>;
}>({ pluginId: "codex", artifactBasename: "test-api.js" });

beforeEach(() => {
  resetIsolatedCompletionTestState();
  mocks.resolveAgentHarnessSelectionDecision.mockImplementation(
    resolveAgentHarnessSelectionDecision,
  );
  completeSimple.mockResolvedValue(isolatedAssistant([{ type: "text", text: "Add two numbers" }]));
});

describe("hosted Responses through Codex admission", () => {
  it.each([true, false])(
    "requires endpoint-binding capability (declared: %s)",
    async (declared) => {
      const baseUrl = "https://hosted.example.com/v1";
      const config = {
        models: {
          providers: {
            openai: { baseUrl, api: "openai-responses" as const, models: [] },
          },
        },
      };
      const registry = createEmptyPluginRegistry();
      const harness = await createCodexHarnessForTest();
      if (!declared) {
        delete harness.providerEndpointBindingSupport;
      }
      registry.agentHarnesses.push({ pluginId: "codex", source: "test", harness });
      Object.assign(preparedModelRuntime, { config, pluginRegistry: registry });
      const model = { provider: "openai", id: "gpt-test", api: "openai-responses", baseUrl };
      mocks.resolveModelAsync.mockResolvedValue({ model });
      // A prepared API-key attempt uses host authorization, without starting a native process.
      mocks.prepareAgentRuntimeAuth.mockReturnValue({
        attempts: [{ kind: "implicit", plan: { providerForAuth: "openai" } }],
      });
      mocks.prepareSimpleCompletionModel.mockResolvedValue({
        model,
        auth: { apiKey: "test-hosted-key", source: "profile:openai:hosted", mode: "api-key" },
      });
      const result = runIsolatedCompletion({ ...isolatedRequest(), config });
      if (!declared) {
        await expect(result).rejects.toThrow("runtime cannot bind the prepared provider endpoint");
        expect(completeSimple).not.toHaveBeenCalled();
        return;
      }
      await expect(result).resolves.toMatchObject({
        text: "Add two numbers",
        owner: { kind: "harness", id: "codex" },
      });
      expect(completeSimple).toHaveBeenCalledOnce();
      expect(completeSimple).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl,
          api: "openai-responses",
          provider: "openai",
          id: "gpt-test",
        }),
        expect.objectContaining({
          tools: [],
          messages: [expect.objectContaining({ content: "Do the task." })],
        }),
        expect.objectContaining({ apiKey: "test-hosted-key" }),
        expect.any(Function),
      );
    },
  );
});
