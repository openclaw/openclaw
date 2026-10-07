import { AgentHarnessSessionSupersededError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { prepareNativeSessionGenerationAuthority } from "openclaw/plugin-sdk/agent-harness-session-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { CodexAppServerBindingIdentity } from "./session-binding-record.js";

/** Decides whether a run may share the durable stable-key binding owner. */
export async function resolveCodexRunSessionBindingAuthority(params: {
  identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>;
  config?: OpenClawConfig;
  storePath?: string;
}): Promise<Awaited<ReturnType<typeof prepareNativeSessionGenerationAuthority>>["state"]> {
  return (
    await prepareNativeSessionGenerationAuthority({
      ...params,
      target: params.identity,
      createSupersededError: createCodexSessionGenerationSupersededError,
    })
  ).state;
}

/** Builds the terminal coordination error used when a newer OpenClaw session owns the binding. */
export function createCodexSessionGenerationSupersededError(
  sessionId: string,
): AgentHarnessSessionSupersededError {
  return new AgentHarnessSessionSupersededError(
    `Codex session generation is no longer current: ${sessionId}`,
  );
}
