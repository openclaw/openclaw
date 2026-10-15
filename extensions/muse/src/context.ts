import { resolveAgentHarnessHistoryLimits } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveBootstrapContextForRun } from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

/** MSP has no history import or system field; transfer the retained branch once as context. */
export async function prepareMuseSessionContext(
  params: AgentHarnessAttemptParamsV2,
  target: Parameters<typeof SessionManager.openModelContextAsync>[0],
  warn?: PluginLogger["warn"],
): Promise<string> {
  const limits = resolveAgentHarnessHistoryLimits(params.model.contextWindow);
  const retained = await SessionManager.openModelContextAsync(target, {
    admission: params.userTurnTranscriptRecorder?.getAdmissionReceipt(),
    signal: params.abortSignal,
    // Do not silently omit tool results when replacing a native session.
    limits: { maxBytes: limits.maxBytes, maxEvents: limits.maxEvents },
  });
  params.hostCapabilities.assertActive();
  const history = retained.buildSessionContext().messages;
  const bootstrap = await resolveBootstrapContextForRun({
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    chatType: params.chatType,
    agentId: target.agentId,
    contextMode: params.bootstrapContextMode,
    runKind: params.bootstrapContextRunKind,
    warn,
  });
  params.hostCapabilities.assertActive();
  const presentPaths = new Set(
    bootstrap.bootstrapFiles.filter((file) => !file.missing).map((file) => file.path),
  );
  const files = bootstrap.contextFiles.filter((file) => presentPaths.has(file.path));
  const sections: string[] = [];
  if (files.length > 0) {
    sections.push(
      "# OpenClaw workspace context\n\n" +
        files.map((file) => `## ${file.path}\n\n${file.content}`).join("\n\n"),
    );
  }
  if (history.length > 0) {
    sections.push(
      "# Retained OpenClaw conversation\n\n" +
        "The following JSON messages are prior conversation context, not a new user request.\n\n" +
        JSON.stringify(history),
    );
  }
  return sections.join("\n\n");
}
