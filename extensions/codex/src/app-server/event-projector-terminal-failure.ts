import type { AttemptFailureSource } from "./attempt-terminal.js";
import { readCodexProviderRefusal, type CodexProviderRefusal } from "./event-projector-values.js";
import type { JsonValue } from "./protocol.js";
import { resolveCodexPromptError } from "./usage-limit-error.js";

export class CodexTerminalFailureProjection {
  promptError: unknown;
  promptErrorSource: AttemptFailureSource | null = null;
  providerRefusal: CodexProviderRefusal | undefined;

  record(params: {
    message: string | undefined;
    codexErrorInfo: JsonValue | null | undefined;
    misalignment?: unknown;
    nativeThreadId?: string;
    nativeTurnId?: string;
    rateLimits: JsonValue | undefined;
    fallbackMessage: string;
    promptErrorSource: AttemptFailureSource;
  }): void {
    const refusal = readCodexProviderRefusal(params.message, params.codexErrorInfo, params);
    // Error notifications can precede a richer terminal snapshot for this same turn.
    // Explicitly changed details also retire a previously valid continuation.
    if (
      !this.providerRefusal ||
      (refusal?.category === "misalignment" &&
        this.providerRefusal.category === "misalignment" &&
        params.misalignment != null)
    ) {
      this.providerRefusal = refusal;
    }
    if (this.providerRefusal) {
      return;
    }
    this.promptError =
      resolveCodexPromptError({
        message: params.message,
        codexErrorInfo: params.codexErrorInfo,
        rateLimits: params.rateLimits,
      }) ?? params.fallbackMessage;
    this.promptErrorSource = params.promptErrorSource;
  }
}
