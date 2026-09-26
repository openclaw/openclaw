import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { withTimeout } from "openclaw/plugin-sdk/time-runtime";
import { parseClaudeCodeVersion, supportsClaudeDynamicSystemPromptSections } from "./cli-shared.js";
import { resolveClaudeTerminalExecutable } from "./session-catalog-executable.js";

const log = createSubsystemLogger("anthropic-cli-version");

/** Share one lazy discovery result between native CLI capabilities and OAuth identity. */
export function createClaudeCodeVersionProbe(api: OpenClawPluginApi) {
  let installedVersion: string | undefined;
  const resolveVersion = createLazyRuntimeModule(async () => {
    try {
      // Login-shell PATH discovery can block well beyond the request probe budget.
      const executable = resolveClaudeTerminalExecutable(process.env, { pathStrategy: "direct" });
      if (!executable) {
        // Without evidence the transport keeps its version floor; say so loudly
        // instead of letting a later 400 blame a CLI the user already updated.
        // Log only the failure category: subprocess output and error text may
        // carry private paths or values the redactor cannot guarantee to strip.
        log.warn(
          "Claude Code version probe: executable-missing; OAuth requests keep the built-in version floor",
        );
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
      if (result.code !== 0 || result.outputLimitExceeded) {
        log.warn(
          "Claude Code version probe: command-failed; OAuth requests keep the built-in version floor",
        );
        return undefined;
      }
      installedVersion = parseClaudeCodeVersion(result.stdout);
      if (!installedVersion) {
        log.warn(
          "Claude Code version probe: unparseable-output; OAuth requests keep the built-in version floor",
        );
      }
      return installedVersion;
    } catch {
      log.warn(
        "Claude Code version probe: probe-error; OAuth requests keep the built-in version floor",
      );
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
