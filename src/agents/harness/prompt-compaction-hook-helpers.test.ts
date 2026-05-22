import { afterEach, describe, expect, it } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../system-prompt-cache-boundary.js";
import { resolveAgentHarnessBeforePromptBuildResult } from "./prompt-compaction-hook-helpers.js";

afterEach(() => {
  resetGlobalHookRunner();
});

describe("resolveAgentHarnessBeforePromptBuildResult", () => {
  it("routes static and dynamic hook system context through the shared cache-boundary composer", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: () => ({
            systemPrompt: `harness stable${SYSTEM_PROMPT_CACHE_BOUNDARY}harness dynamic`,
            prependSystemContext: "static pre",
            appendSystemContext: "static post",
            prependDynamicSystemContext: "dynamic pre",
            appendDynamicSystemContext: "dynamic post",
            prependContext: "queued context",
          }),
        },
      ]),
    );

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "hello",
      developerInstructions: `base stable${SYSTEM_PROMPT_CACHE_BOUNDARY}base dynamic`,
      messages: [],
      ctx: {
        runId: "run-harness-test",
        agentId: "agent-harness-test",
        sessionKey: "agent:main:harness-test",
        sessionId: "session-harness-test",
        workspaceDir: "/tmp/openclaw-harness-test",
        modelProviderId: "test",
        modelId: "test-model",
        trigger: "user",
      },
    });

    expect(result.prompt).toBe("queued context\n\nhello");
    const markerIdx = result.developerInstructions.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(markerIdx).toBeGreaterThan(-1);
    const cacheablePrefix = result.developerInstructions.slice(0, markerIdx);
    const dynamicSuffix = result.developerInstructions.slice(
      markerIdx + SYSTEM_PROMPT_CACHE_BOUNDARY.length,
    );
    expect(cacheablePrefix).toContain("static pre");
    expect(cacheablePrefix).toContain("harness stable");
    expect(cacheablePrefix).toContain("static post");
    expect(dynamicSuffix).toContain("dynamic pre");
    expect(dynamicSuffix).toContain("harness dynamic");
    expect(dynamicSuffix).toContain("dynamic post");
    expect(cacheablePrefix).not.toContain("dynamic pre");
    expect(cacheablePrefix).not.toContain("dynamic post");
  });
});
