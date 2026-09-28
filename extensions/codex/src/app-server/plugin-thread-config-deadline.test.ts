// Regression coverage for the plugin config discovery deadline clock domain.
// Extracted from plugin-thread-config.test.ts to respect the line-cap ratchet;
// the assertions are unchanged.
import { describe, expect, it, vi } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "./config.js";
import { pluginInstalled, pluginList } from "./plugin-inventory.test-helpers.js";
import { CodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import { createCodexPluginThreadConfigStartupProvider } from "./plugin-thread-config-deadline.js";

describe("Codex plugin thread config deadline", () => {
  it("keeps the plugin config deadline bounded when the wall clock rewinds", async () => {
    // Drive time with fake timers: setSystemTime rewinds the wall clock (Date.now)
    // while advanceTimersByTimeAsync advances the monotonic clock (performance.now).
    // A wall-clock-based remaining budget would grow when Date.now() rewinds; the
    // monotonic budget must stay bounded by the configured startup budget.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const capturedTimeoutMs: number[] = [];
      const request = vi.fn(
        async (
          method: string,
          _params: unknown,
          options: { timeoutMs: number; signal: AbortSignal },
        ) => {
          capturedTimeoutMs.push(options.timeoutMs);
          // Rewind the wall clock after the first RPC so subsequent remaining-budget
          // computations run against a regressed Date.now().
          if (capturedTimeoutMs.length === 1) {
            vi.setSystemTime(-120_000);
          }
          if (method === "config/read") {
            return { config: {}, layers: [] };
          }
          return method === "plugin/installed" ? pluginInstalled([]) : pluginList([]);
        },
      );

      const buildPromise = createCodexPluginThreadConfigStartupProvider({
        inputFingerprint: undefined,
        enabledPluginConfigKeys: undefined,
        policy: undefined,
        requestTimeoutMs: 60_000,
        signal: new AbortController().signal,
        pluginConfig: {
          codexPlugins: {
            enabled: true,
            plugins: {
              calendar: {
                marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
                pluginName: "calendar",
              },
            },
          },
        },
        appCache: new CodexAppInventoryCache(),
        appCacheKey: "runtime-wall-clock-rewind",
        metadataCache: new CodexPluginMetadataCache(),
        client: { request },
      }).build();

      // Let the config build run to completion under fake timers.
      await vi.advanceTimersByTimeAsync(60_000).then(() => buildPromise);

      // Every RPC must receive a timeout bounded by the 60s startup budget, even
      // after the wall clock rewinds. A wall-clock budget would hand the second
      // RPC a timeoutMs well above 60_000.
      expect(capturedTimeoutMs.length).toBeGreaterThan(1);
      for (const captured of capturedTimeoutMs) {
        expect(captured).toBeLessThanOrEqual(60_000);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
