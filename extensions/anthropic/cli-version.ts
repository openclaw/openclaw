import fs from "node:fs/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { withTimeout } from "openclaw/plugin-sdk/time-runtime";
import { parseClaudeCodeVersion, supportsClaudeDynamicSystemPromptSections } from "./cli-shared.js";
import { resolveClaudeTerminalExecutable } from "./session-catalog-executable.js";

const log = createSubsystemLogger("anthropic-cli-version");

type VersionProbe = {
  key: string | undefined;
  version: string | undefined;
  result: Promise<string | undefined>;
};

async function readExecutableIdentity(executable: string): Promise<string> {
  const realPath = await fs.realpath(executable);
  const stat = await fs.stat(realPath);
  return JSON.stringify([executable, realPath, stat.mtimeMs, stat.size]);
}

/** Share installed-file evidence between native CLI capabilities and OAuth identity. */
export function createClaudeCodeVersionProbe(api: OpenClawPluginApi) {
  let current: VersionProbe | undefined;
  const probe = async (executable: string | undefined, initialFailure: string) => {
    let failure = initialFailure;
    try {
      if (executable) {
        failure = "probe-error";
        // The runner retains process cleanup; requests need not wait for a slow tree kill.
        const result = await withTimeout(
          api.runtime.system.runCommandWithTimeout([executable, "--version"], {
            timeoutMs: 1_500,
            killProcessTree: true,
            killGraceMs: 100,
            maxOutputBytes: { stdout: 1_024, stderr: 1_024 },
            terminateOnOutputLimit: true,
          }),
          1_500,
        );
        failure = "command-failed";
        if (result.code === 0 && !result.outputLimitExceeded) {
          const version = parseClaudeCodeVersion(result.stdout);
          if (version) {
            return version;
          }
          failure = "unparseable-output";
        }
      }
    } catch {
      // Keep raw subprocess output, paths and error text out of diagnostics.
    }
    log.warn(
      `Claude Code version probe: ${failure}; OAuth requests keep the built-in version floor`,
    );
    return undefined;
  };
  const resolveVersion = async () => {
    let executable: string | undefined;
    let key: string | undefined;
    let failure = "executable-missing";
    try {
      // Login-shell PATH discovery can block well beyond the request probe budget.
      executable = resolveClaudeTerminalExecutable(process.env, {
        pathStrategy: "direct",
      })?.executable;
      if (executable) {
        failure = "probe-error";
        key = await withTimeout(readExecutableIdentity(executable), 1_500);
      }
      if (current && current.key === key) {
        return current.result;
      }
      // Metadata reads yield; resolve again before launching through the existing validator.
      if (
        key &&
        resolveClaudeTerminalExecutable(process.env, { pathStrategy: "direct" })?.executable !==
          executable
      ) {
        key = undefined;
      }
    } catch {
      key = undefined;
      failure = "probe-error";
    }
    // One entry shares in-flight work and caches failures until the installed file changes.
    // A replacement during a probe is observed on the next request.
    const next: VersionProbe = {
      key,
      version: undefined,
      result: probe(key ? executable : undefined, failure).then((version) => {
        next.version = version;
        return version;
      }),
    };
    current = next;
    return next.result;
  };
  return {
    resolveVersion,
    ensureDynamicSystemPromptSectionsSupport: async () => {
      await resolveVersion();
    },
    supportsDynamicSystemPromptSections: () =>
      supportsClaudeDynamicSystemPromptSections(current?.version),
  };
}
