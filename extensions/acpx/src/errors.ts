import type { OutputErrorAcpPayload, OutputErrorCode, OutputErrorOrigin } from "./runtime-types.js";

type AcpxErrorOptions = ErrorOptions & {
  outputCode?: OutputErrorCode;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
  outputAlreadyEmitted?: boolean;
};

export class AcpxOperationalError extends Error {
  readonly outputCode?: OutputErrorCode;
  readonly detailCode?: string;
  readonly origin?: OutputErrorOrigin;
  readonly retryable?: boolean;
  readonly acp?: OutputErrorAcpPayload;
  readonly outputAlreadyEmitted?: boolean;

  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.outputCode = options?.outputCode;
    this.detailCode = options?.detailCode;
    this.origin = options?.origin;
    this.retryable = options?.retryable;
    this.acp = options?.acp;
    this.outputAlreadyEmitted = options?.outputAlreadyEmitted;
  }
}

export class SessionNotFoundError extends AcpxOperationalError {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.sessionId = sessionId;
  }
}

export class SessionResolutionError extends AcpxOperationalError {}

export class AgentSpawnError extends AcpxOperationalError {
  readonly agentCommand: string;

  constructor(agentCommand: string, cause?: unknown) {
    super(`Failed to spawn agent command: ${agentCommand}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
    this.agentCommand = agentCommand;
  }
}

export class AgentDisconnectedError extends AcpxOperationalError {
  readonly reason: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(
    reason: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    options?: AcpxErrorOptions,
  ) {
    super(
      `ACP agent disconnected during request (${reason}, exit=${exitCode ?? "null"}, signal=${signal ?? "null"})`,
      {
        outputCode: "RUNTIME",
        detailCode: "AGENT_DISCONNECTED",
        origin: "acp",
        ...options,
      },
    );
    this.reason = reason;
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

export class SessionResumeRequiredError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "RUNTIME",
      detailCode: "SESSION_RESUME_REQUIRED",
      origin: "acp",
      retryable: true,
      ...options,
    });
  }
}

export class GeminiAcpStartupTimeoutError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "TIMEOUT",
      detailCode: "GEMINI_ACP_STARTUP_TIMEOUT",
      origin: "acp",
      ...options,
    });
  }
}

export class SessionModeReplayError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "RUNTIME",
      detailCode: "SESSION_MODE_REPLAY_FAILED",
      origin: "acp",
      ...options,
    });
  }
}

export class SessionModelReplayError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "RUNTIME",
      detailCode: "SESSION_MODEL_REPLAY_FAILED",
      origin: "acp",
      ...options,
    });
  }
}

export class ClaudeAcpSessionCreateTimeoutError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "TIMEOUT",
      detailCode: "CLAUDE_ACP_SESSION_CREATE_TIMEOUT",
      origin: "acp",
      ...options,
    });
  }
}

export class CopilotAcpUnsupportedError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "RUNTIME",
      detailCode: "COPILOT_ACP_UNSUPPORTED",
      origin: "acp",
      ...options,
    });
  }
}

export class AuthPolicyError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "RUNTIME",
      detailCode: "AUTH_REQUIRED",
      origin: "acp",
      ...options,
    });
  }
}

export class QueueConnectionError extends AcpxOperationalError {}

export class QueueProtocolError extends AcpxOperationalError {}

export class PermissionDeniedError extends AcpxOperationalError {}

export class PermissionPromptUnavailableError extends AcpxOperationalError {
  constructor() {
    super("Permission prompt unavailable in non-interactive mode");
  }
}
