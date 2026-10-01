import { vi } from "vitest";
import {
  authorizeClientVoiceConfirmation,
  bindAuthorizedClientVoiceConfirmation,
  checkClientVoiceToolConfirmationPolicy,
} from "../talk/client-voice-confirmation.js";
import { noteClientVoiceConfirmationUtteranceForTest as noteClientVoiceConfirmationUtterance } from "../talk/client-voice-confirmation.test-support.js";
import * as clientVoiceSession from "../talk/client-voice-session.js";

export function installVoiceRunBinding(runId: string): void {
  const binding = {
    agentId: "main",
    voiceSessionId: `voice-${runId}`,
    sessionKey: "agent:main:voice",
  };
  vi.spyOn(clientVoiceSession, "resolveClientVoiceRunBinding").mockImplementation(
    (candidateRunId) => (candidateRunId === runId ? binding : undefined),
  );
  vi.spyOn(clientVoiceSession, "isClientVoiceSessionConfirmable").mockReturnValue(true);
}

export function authorizeVoiceToolParams(runId: string, toolParams: unknown, now = Date.now()) {
  const voiceSessionId = `voice-${runId}`;
  const challenge = checkClientVoiceToolConfirmationPolicy({
    agentId: "main",
    voiceSessionId,
    runId,
    toolName: "message",
    toolParams,
    isConfirmable: () => true,
    now,
  });
  if (challenge.allowed) {
    throw new Error("expected voice confirmation challenge");
  }
  const confirmationId = challenge.reason.match(/VOICE_CONFIRMATION_REQUIRED:([^\s]+)/)?.[1];
  if (!confirmationId) {
    throw new Error("missing voice confirmation id");
  }
  noteClientVoiceConfirmationUtterance({
    agentId: "main",
    voiceSessionId,
    text: "yes",
    timestamp: now + 1,
  });
  const grant = authorizeClientVoiceConfirmation({
    agentId: "main",
    voiceSessionId,
    confirmationId,
    now: now + 2,
  });
  return { confirmationId, grant, voiceSessionId };
}

export function approveVoiceToolParams(runId: string, toolParams: unknown): void {
  const { grant } = authorizeVoiceToolParams(runId, toolParams);
  bindAuthorizedClientVoiceConfirmation({ grant, runId });
}
