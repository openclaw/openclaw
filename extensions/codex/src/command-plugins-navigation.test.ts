import { describe, expect, it } from "vitest";
import { handleCodexPluginsSubcommand } from "./command-plugins-management.js";
import { fakeCtx, inMemoryIO, pluginRuntime } from "./command-plugins-management.test-support.js";

describe("Codex plugin navigation", () => {
  it.each(["my notes", String.raw`reviewer's "notes"\archive`])(
    "inspects a configured alias %s by its qualified plugin identity",
    async (configKey) => {
      const io = inMemoryIO({
        [configKey]: {
          pluginName: "security-review",
          marketplaceName: "company-tools",
          enabled: true,
        },
      });
      const runtime = pluginRuntime({ installed: true, enabled: true });
      const result = await handleCodexPluginsSubcommand(
        fakeCtx,
        ["status", "security-review@company-tools"],
        io,
        {
          ...runtime,
          withContext: (run) =>
            runtime.withContext((context) => run({ ...context, current: io.currentConfig() })),
        },
      );
      expect(result.text).toContain("Plugin: security-review");
      expect(result.text).toContain("Bundle: installed");
    },
  );
});
