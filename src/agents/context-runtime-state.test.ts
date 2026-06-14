import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { execNodeEvalSync } from "../test-utils/node-process.js";
import { lookupCachedContextWindow, providerContextTokenCacheKey } from "./context-cache.js";
import {
  CONTEXT_WINDOW_RUNTIME_STATE,
  resetContextWindowCacheForTest,
} from "./context-runtime-state.js";
import { ensureContextWindowCacheLoaded } from "./context.js";

afterEach(() => {
  resetContextWindowCacheForTest();
});

describe("context runtime state", () => {
  it("normalizes the singleton shape held by a released gateway", () => {
    const moduleUrl = new URL("./context-runtime-state.ts", import.meta.url).href;
    const output = execNodeEvalSync(
      `
        const key = Symbol.for("openclaw.contextWindowRuntimeState");
        const legacyLoadPromise = Promise.resolve();
        globalThis[key] = {
          loadPromise: legacyLoadPromise,
          configuredConfig: undefined,
          configLoadFailures: 0,
          nextConfigLoadAttemptAtMs: 0,
          modelsConfigRuntimeLoader: { clear() {} },
        };
        const { CONTEXT_WINDOW_RUNTIME_STATE: state } = await import(${JSON.stringify(moduleUrl)});
        process.stdout.write([
          state.generation,
          state.loadGeneration === null,
          state.loadPromise === legacyLoadPromise,
        ].join(":"));
      `,
      { imports: ["tsx"] },
    );

    expect(output).toBe("0:true:true");
  });

  it("warms fresh caches instead of reusing a pre-generation load promise", async () => {
    const legacyLoadPromise = Promise.resolve();
    CONTEXT_WINDOW_RUNTIME_STATE.loadPromise = legacyLoadPromise;
    CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration = null;
    CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig = {
      models: {
        providers: {
          "fresh-provider": {
            baseUrl: "https://example.invalid",
            models: [{ id: "fresh-model", contextWindow: 123_456 } as never],
          },
        },
      },
    } satisfies OpenClawConfig;

    await ensureContextWindowCacheLoaded();

    expect(
      lookupCachedContextWindow(providerContextTokenCacheKey("fresh-provider", "fresh-model")),
    ).toBe(123_456);
    expect(CONTEXT_WINDOW_RUNTIME_STATE.loadPromise).not.toBe(legacyLoadPromise);
    expect(CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration).toBe(
      CONTEXT_WINDOW_RUNTIME_STATE.generation,
    );
  });
});
