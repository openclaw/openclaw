// Regression coverage for AgentSession defensive boundaries.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "./auth-storage.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { LoadExtensionsResult } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const testModel = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

function createEmptyResourceLoader(): ResourceLoader {
  const extensionsResult: LoadExtensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

describe("AgentSession", () => {
  let originalStderrWrite: typeof process.stderr.write;
  const stderrChunks: string[] = [];

  beforeEach(() => {
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    stderrChunks.length = 0;
    // Swallow stderr during the test: we only need to detect the generic
    // diagnostic, and we must not risk logging provider/config details.
    process.stderr.write = (chunk: string | Uint8Array) => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      stderrChunks.push(text);
      return true;
    };
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
  });

  it("logs a diagnostic when the extension abort fallback rejects", async () => {
    const { session } = await createAgentSession({
      model: testModel as never,
      resourceLoader: createEmptyResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    });

    const runner = (session as unknown as { currentExtensionRunner?: { abortFn?: () => void } })
      .currentExtensionRunner;
    expect(runner?.abortFn).toBeTypeOf("function");

    // Simulate a rejecting session abort to exercise the defensive catch.
    const originalAbort = session.abort.bind(session);
    (session as { abort: () => Promise<void> }).abort = async () => {
      await originalAbort();
      throw new Error("simulated abort rejection");
    };

    runner!.abortFn!();

    // Wait for the fire-and-forget promise catch handler to run.
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    const stderr = stderrChunks.join("");
    expect(stderr).toContain("agent-session: extension abort failed");
  });
});
