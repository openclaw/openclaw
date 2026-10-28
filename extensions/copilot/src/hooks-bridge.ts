/**
 * Compatibility adapter for native Copilot SDK SessionHooks.
 *
 * `hooksConfig` is a shipped Copilot-specific per-attempt API. It remains
 * separate from OpenClaw's generic lifecycle hooks because the SDK callbacks
 * expose native events and decisions that the portable hook contract does not.
 */
import type { SessionConfig } from "@github/copilot-sdk";

type SdkSessionHooks = NonNullable<SessionConfig["hooks"]>;

interface CopilotHooksBridgeOptions {
  onUserPromptSubmitted?: (submission: { prompt: string; additionalContext?: string }) => void;
}

export interface CopilotHooksConfig extends Pick<
  SdkSessionHooks,
  | "onPreToolUse"
  | "onPreMcpToolCall"
  | "onPostToolUse"
  | "onPostToolUseFailure"
  | "onUserPromptSubmitted"
  | "onSessionStart"
  | "onSessionEnd"
  | "onErrorOccurred"
> {
  /**
   * Called when a native SDK hook handler throws. Defaults to console.warn so
   * native hook failures do not terminate the SDK session.
   */
  onHookError?: (info: { hookName: keyof SdkSessionHooks; error: unknown }) => void;
}

const DEFAULT_HOOK_ERROR_HANDLER: NonNullable<CopilotHooksConfig["onHookError"]> = ({
  hookName,
  error,
}) => {
  console.warn(`[copilot hooks-bridge] ${hookName} handler threw:`, error);
};

/**
 * Wrap a native handler so it cannot throw into the SDK. Returning undefined
 * leaves the SDK's default decision in place.
 */
function isolate<TArgs extends readonly unknown[], TResult>(
  hookName: keyof SdkSessionHooks,
  handler: ((...args: TArgs) => TResult | Promise<TResult>) | undefined,
  onError: NonNullable<CopilotHooksConfig["onHookError"]>,
): ((...args: TArgs) => Promise<TResult | undefined>) | undefined {
  if (!handler) {
    return undefined;
  }
  return async (...args: TArgs) => {
    try {
      return await handler(...args);
    } catch (error) {
      try {
        onError({ hookName, error });
      } catch {
        // Never let the error notifier itself throw into the SDK.
      }
      return undefined;
    }
  };
}

/**
 * Build an SDK-shaped hook object from native per-attempt configuration.
 * Omit the SDK hook subsystem when no handlers were configured.
 */
export function createHooksBridge(
  config?: CopilotHooksConfig,
  options?: CopilotHooksBridgeOptions,
): SdkSessionHooks | undefined {
  if (!config) {
    return undefined;
  }
  const onError = config.onHookError ?? DEFAULT_HOOK_ERROR_HANDLER;
  const hooks: SdkSessionHooks = {
    onPreToolUse: isolate("onPreToolUse", config.onPreToolUse, onError),
    onPreMcpToolCall: isolate("onPreMcpToolCall", config.onPreMcpToolCall, onError),
    onPostToolUse: isolate("onPostToolUse", config.onPostToolUse, onError),
    onPostToolUseFailure: isolate("onPostToolUseFailure", config.onPostToolUseFailure, onError),
    onSessionStart: isolate("onSessionStart", config.onSessionStart, onError),
    onSessionEnd: isolate("onSessionEnd", config.onSessionEnd, onError),
    onErrorOccurred: isolate("onErrorOccurred", config.onErrorOccurred, onError),
  };
  const userPrompt = isolate("onUserPromptSubmitted", config.onUserPromptSubmitted, onError);
  if (userPrompt) {
    hooks.onUserPromptSubmitted = async (input, invocation) => {
      const output = await userPrompt(input, invocation);
      try {
        options?.onUserPromptSubmitted?.({
          prompt: output?.modifiedPrompt ?? input.prompt,
          ...(output?.additionalContext ? { additionalContext: output.additionalContext } : {}),
        });
      } catch (error) {
        try {
          onError({ hookName: "onUserPromptSubmitted", error });
        } catch {
          // Never let an observer or its error notifier throw into the SDK.
        }
      }
      return output;
    };
  }
  for (const key of Object.keys(hooks) as (keyof SdkSessionHooks)[]) {
    if (hooks[key] === undefined) {
      delete hooks[key];
    }
  }

  return Object.keys(hooks).length > 0 ? hooks : undefined;
}
