import fs from "node:fs/promises";
import path from "node:path";
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveCodexAppServerVerifiedLocalHomeDir } from "./auth-start-options.js";
import { withCodexClientWorkspace } from "./client-runtime.js";
import {
  readCodexWorkspaceModelContext,
  type CodexNativeModelContext,
} from "./client-workspace-state.js";
import { readCodexAuthoredConfigValue } from "./config-layer-policy.js";
import type { CodexConfigReadResponse } from "./protocol-control-plane.js";
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
    // session_meta keeps the creation-time text, while a thread Codex loads runs with its
    // config override when one is set (codex-rs/core/src/session/mod.rs: config
    // base_instructions before session_meta); OpenClaw sends none on thread/resume. A thread
    // started or forked this attempt recorded its live text, so only resumes can differ.
    const config = thread.preparedEffectiveConfig;
    return thread.lifecycle.action === "resumed" && config
      ? await withConfiguredBaseInstructions(recorded, config, thread.threadId, signal)
      : recorded;
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
 * Codex's base-instruction override: the trimmed `model_instructions_file`, else
 * `instructions` (codex-rs/core/src/config/mod.rs). A resumed thread may be a warm thread
 * Codex loaded before the file changed, and thread/resume reuses a loaded thread without
 * reloading config, so the result is an estimate. A failed read keeps the rollout result.
 */
async function withConfiguredBaseInstructions(
  recorded: CodexNativeModelContext,
  config: CodexConfigReadResponse,
  threadId: string,
  signal: AbortSignal,
): Promise<CodexNativeModelContext> {
  // Codex resolves the path against its config layer before config/read reports it.
  const file = readCodexAuthoredConfigValue(config, "model_instructions_file");
  const instructions = config.config.instructions;
  if (typeof file !== "string") {
    return typeof instructions === "string"
      ? { ...recorded, baseInstructions: instructions, baseInstructionsEstimated: true }
      : recorded;
  }
  let baseInstructions = recorded.baseInstructions;
  try {
    baseInstructions = (await fs.readFile(file, { encoding: "utf8", signal })).trim();
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    embeddedAgentLog.debug("codex configured base instructions unavailable for the report", {
      threadId,
      error: formatErrorMessage(error),
    });
  }
  return baseInstructions === undefined
    ? recorded
    : { ...recorded, baseInstructions, baseInstructionsEstimated: true };
}
