import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { withTimeout } from "openclaw/plugin-sdk/time-runtime";
import { parseClaudeCodeVersion, supportsClaudeDynamicSystemPromptSections } from "./cli-shared.js";
import { resolveClaudeTerminalExecutable } from "./session-catalog-executable.js";

/** Share one lazy discovery result between native CLI capabilities and OAuth identity. */
export function createClaudeCodeVersionProbe(api: OpenClawPluginApi) {
  let installedVersion: string | undefined;
  const resolveVersion = createLazyRuntimeModule(async () => {
    try {
      // Login-shell PATH discovery can block well beyond the request probe budget.
      const executable = resolveClaudeTerminalExecutable(process.env, { pathStrategy: "direct" });
      if (!executable) {
        return undefined;
      }
      // The runner retains process cleanup; requests need not wait for a slow tree kill.
      const result = await withTimeout(
        api.runtime.system.runCommandWithTimeout([executable.executable, "--version"], {
          timeoutMs: 1_500,
          killProcessTree: true,
          killGraceMs: 100,
          maxOutputBytes: { stdout: 1_024, stderr: 1_024 },
          terminateOnOutputLimit: true,
        }),
        1_500,
      );
      installedVersion =
        result.code === 0 && !result.outputLimitExceeded
          ? parseClaudeCodeVersion(result.stdout)
          : undefined;
      return installedVersion;
    } catch {
      return undefined;
    }
  });
  return {
    resolveVersion,
    ensureDynamicSystemPromptSectionsSupport: async () => {
      await resolveVersion();
    },
    supportsDynamicSystemPromptSections: () =>
      supportsClaudeDynamicSystemPromptSections(installedVersion),
  };
}
