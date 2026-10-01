import { readCodexPluginConfig } from "./app-server/config-parsing.js";

export class CodexSupervisionPolicyError extends Error {}

type CodexSupervisionPolicyOptions = {
  senderIsOwner: boolean;
  assertInvocationCurrent?: () => void;
};

export function requireSupervisionEnabled(pluginConfig: unknown): void {
  if (readCodexPluginConfig(pluginConfig).supervision?.enabled !== true) {
    throw new CodexSupervisionPolicyError(
      "Codex supervision is disabled in the codex plugin config.",
    );
  }
}

export function requireOwnerAccess(options: CodexSupervisionPolicyOptions): void {
  options.assertInvocationCurrent?.();
  if (!options.senderIsOwner) {
    throw new CodexSupervisionPolicyError(
      "Codex supervision compatibility tools require an owner-authorized sender.",
    );
  }
}

export function resolveToolPolicy(pluginConfig: unknown): {
  allowRawTranscripts: boolean;
  allowWriteControls: boolean;
} {
  const config = readCodexPluginConfig(pluginConfig).supervision;
  return {
    allowRawTranscripts: config?.allowRawTranscripts === true,
    allowWriteControls: config?.allowWriteControls === true,
  };
}

export function requireRawTranscriptAccess(pluginConfig: unknown): void {
  if (!resolveToolPolicy(pluginConfig).allowRawTranscripts) {
    throw new CodexSupervisionPolicyError(
      "Codex session reads are disabled for this codex plugin supervision config.",
    );
  }
}

export function requireWriteAccess(pluginConfig: unknown): void {
  if (!resolveToolPolicy(pluginConfig).allowWriteControls) {
    throw new CodexSupervisionPolicyError(
      "Codex write controls are disabled for this codex plugin supervision config.",
    );
  }
}
