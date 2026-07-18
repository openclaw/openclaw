import { formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";

export class CodexThreadStartRequestError extends Error {
  constructor(cause: unknown) {
    super(formatErrorMessage(cause), { cause });
    this.name = "CodexThreadStartRequestError";
  }
}

export class CodexThreadBindingConflictError extends Error {
  constructor(threadId: string, operation: string) {
    super(`Codex thread binding changed while ${operation}: ${threadId}`);
    this.name = "CodexThreadBindingConflictError";
  }
}

export class CodexRingZeroAttestationError extends Error {
  constructor(cause: unknown) {
    super("Codex ring-zero MCP attestation failed", { cause });
    this.name = "CodexRingZeroAttestationError";
  }
}

export class CodexThreadBindingConflictAfterCleanupError extends CodexThreadBindingConflictError {}

export class CodexAdoptedThreadActiveError extends Error {
  constructor() {
    super("Codex session became active in another runner; wait for it to finish before continuing");
    this.name = "CodexAdoptedThreadActiveError";
  }
}

export class CodexSessionGenerationNotCurrentError extends Error {
  constructor(identity: { sessionId: string; sessionKey?: string }) {
    const sessionKey = identity.sessionKey?.trim();
    // A stable sessionKey pins one OpenClaw session generation, so a run whose sessionId
    // no longer owns that generation cannot reclaim the key. Give embedded callers an
    // actionable identity choice instead of the bare reclaim failure.
    const guidance = sessionKey
      ? ` A newer OpenClaw session generation owns sessionKey "${sessionKey}", so this run's sessionId is no longer that key's current generation. For isolated embedded runs that rotate sessionId per call, omit sessionKey so each run keeps its own identity; to continue one logical session, reuse the same sessionId instead of rotating it.`
      : "";
    super(`Codex session generation is no longer current: ${identity.sessionId}.${guidance}`);
    this.name = "CodexSessionGenerationNotCurrentError";
  }
}
