import fs from "node:fs/promises";
import path from "node:path";
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveCodexAppServerVerifiedLocalHomeDir } from "./auth-start-options.js";
import { withCodexClientWorkspace } from "./client-runtime.js";
import {
  readCodexWorkspaceModelContext,
  type CodexNativeModelContext,
} from "./client-workspace-state.js";
import {
  readCodexAuthoredConfigValue,
  readCodexEffectiveConfig,
  type CodexConfigReadClient,
} from "./config-layer-policy.js";
import type { StartedCodexAttemptResources } from "./run-attempt-start.js";

/**
 * Codex records its base instructions and AGENTS.md injection only in its own rollout;
 * app-server responses expose neither. Undefined means no readable local record (or an
 * abandoned read), which leaves AGENTS.md unverified; it never fails the turn.
 */
export async function readCodexNativeModelContext(
  resources: StartedCodexAttemptResources,
  signal: AbortSignal,
): Promise<CodexNativeModelContext | undefined> {
  const { client, thread } = resources.state;
  try {
    const { appServer, agentDir } = resources.prompt.context.runtime.connection;
    const home = resolveCodexAppServerVerifiedLocalHomeDir(
      appServer,
      agentDir,
      client.getRuntimeIdentity()?.codexHome,
    );
    if (!home) {
      return undefined;
    }
    const recorded = await withCodexClientWorkspace(client, (state, maxCachedSessions) =>
      readCodexWorkspaceModelContext(
        client,
        state,
        path.join(home, "sessions"),
        thread.rolloutPath,
        thread.threadId,
        maxCachedSessions,
        signal,
      ),
    );
    // session_meta keeps the creation-time text, but a loaded thread runs with Codex's
    // config override when one is set (codex-rs/core/src/session/mod.rs: config
    // base_instructions before session_meta), and OpenClaw sends none on thread/resume.
    // A started or forked thread wrote its live text to session_meta this attempt.
    if (thread.lifecycle.action !== "resumed") {
      return recorded;
    }
    const configured = await readCodexConfiguredBaseInstructions(
      client,
      resources.state.codexExecutionCwd,
      signal,
    );
    return configured === undefined ? recorded : { ...recorded, baseInstructions: configured };
  } catch (error) {
    if (!signal.aborted) {
      embeddedAgentLog.debug("codex native model context unavailable for the context report", {
        threadId: thread.threadId,
        error: formatErrorMessage(error),
      });
    }
    return undefined;
  }
}

/**
 * Codex's config override for base instructions: the trimmed `model_instructions_file`,
 * else `instructions` (codex-rs/core/src/config/mod.rs). Accepted gap: a warm thread keeps
 * the text from its last load, so an edit since then shows here until Codex reloads it.
 */
async function readCodexConfiguredBaseInstructions(
  client: CodexConfigReadClient,
  cwd: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const snapshot = await readCodexEffectiveConfig(client, cwd, { signal });
  // Codex resolves the path against its config layer before config/read reports it.
  const file = readCodexAuthoredConfigValue(snapshot, "model_instructions_file");
  if (typeof file === "string") {
    return (await fs.readFile(file, { encoding: "utf8", signal })).trim();
  }
  const instructions = snapshot.config.instructions;
  return typeof instructions === "string" ? instructions : undefined;
}
