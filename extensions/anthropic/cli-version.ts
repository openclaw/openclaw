import fs from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { withTimeout } from "openclaw/plugin-sdk/time-runtime";
import { parseClaudeCodeVersion, supportsClaudeDynamicSystemPromptSections } from "./cli-shared.js";
import { resolveClaudeTerminalExecutable } from "./session-catalog-executable.js";

// A missing, failed or slow probe keeps the transport floor this long before discovery repeats.
// Repeated discovery sees PATH changes; the native-install fallback keeps its own restart-scoped cache.
const FAILED_PROBE_RETRY_MS = 60_000;

type Discovery = {
  executable?: string;
  artifact?: string;
  version?: Promise<string | undefined>;
  failedAt?: number;
};

/** Identify the installed file, so an in-place update or a relinked install is probed again. */
function readExecutableArtifact(executable: string): string | undefined {
  try {
    const realPath = fs.realpathSync(executable);
    const stat = fs.statSync(realPath);
    return [realPath, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
  } catch {
    return undefined;
  }
}

/**
 * Share discovery between native CLI capabilities and OAuth identity.
 * A result stays valid while the same executable file is installed; failures are retried.
 */
export function createClaudeCodeVersionProbe(api: OpenClawPluginApi) {
  let installedVersion: string | undefined;
  let current: Discovery | undefined;

  const probe = async (executable: string): Promise<string | undefined> => {
    try {
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
      return result.code === 0 && !result.outputLimitExceeded
        ? parseClaudeCodeVersion(result.stdout)
        : undefined;
    } catch {
      return undefined;
    }
  };

  const discover = (): Discovery => {
    let executable: string | undefined;
    try {
      // Login-shell PATH discovery can block well beyond the request probe budget.
      executable = resolveClaudeTerminalExecutable(process.env, {
        pathStrategy: "direct",
      })?.executable;
    } catch {
      executable = undefined;
    }
    const discovery: Discovery = {
      executable,
      artifact: executable ? readExecutableArtifact(executable) : undefined,
    };
    discovery.version = (executable ? probe(executable) : Promise.resolve(undefined)).then(
      (version) => {
        if (current === discovery) {
          installedVersion = version;
        }
        if (!version) {
          discovery.failedAt = Date.now();
        }
        return version;
      },
    );
    return discovery;
  };

  const isCurrent = (discovery: Discovery): boolean => {
    // A replaced executable is probed again at once, also after a failed probe.
    if (
      discovery.executable !== undefined &&
      readExecutableArtifact(discovery.executable) !== discovery.artifact
    ) {
      return false;
    }
    // A pending or successful probe is shared; a failed one holds the floor for the retry interval.
    return (
      discovery.failedAt === undefined || Date.now() - discovery.failedAt < FAILED_PROBE_RETRY_MS
    );
  };

  const resolveVersion = (): Promise<string | undefined> => {
    if (!current || !isCurrent(current)) {
      current = discover();
    }
    return current.version ?? Promise.resolve(undefined);
  };

  return {
    resolveVersion,
    ensureDynamicSystemPromptSectionsSupport: async () => {
      await resolveVersion();
    },
    supportsDynamicSystemPromptSections: () =>
      supportsClaudeDynamicSystemPromptSections(installedVersion),
  };
}
