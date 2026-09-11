// Live local session source for Claude Code: projects this machine's
// interactive Claude sessions to the team through the Gateway bridge. The
// definition stays dependency-light for node-host registration; the tailer,
// watcher, and channel bridge load from the runtime module on first start.
import os from "node:os";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { LocalSessionSourceDefinition } from "openclaw/plugin-sdk/local-session-source";
import { enableClaudeLocalSharing } from "./local-session-setup.js";
import type { ClaudeLocalSessionSourceRuntimeOptions } from "./local-session-source.runtime.js";
import { claudeProjectsAvailable } from "./session-catalog-home.js";

const CLAUDE_LOCAL_SESSION_SOURCE_ID = "claude";
const CLAUDE_LOCAL_SESSION_SOURCE_COMMAND = "anthropic.claude.localSessions.source.v1";

const loadClaudeLocalSessionSourceRuntime = createLazyRuntimeModule(
  () => import("./local-session-source.runtime.js"),
);

export function createClaudeLocalSessionSource(
  config: ClaudeLocalSessionSourceRuntimeOptions & { hostLabel?: string } = {},
): LocalSessionSourceDefinition {
  return {
    id: CLAUDE_LOCAL_SESSION_SOURCE_ID,
    label: "Claude Code",
    command: CLAUDE_LOCAL_SESSION_SOURCE_COMMAND,
    hostLabel: config.hostLabel ?? os.hostname(),
    // Channel events land at the next turn boundary; Claude Code has no steer.
    inputModes: ["followup"],
    // Same gate as the catalog commands: this machine must own a Claude session store.
    isAvailable: ({ env }) => claudeProjectsAvailable(env),
    enableSharing: ({ env }) => enableClaudeLocalSharing({ env }),
    start: async (host, options) =>
      (await loadClaudeLocalSessionSourceRuntime()).startClaudeLocalSessionSource(
        host,
        options,
        config,
      ),
  };
}
