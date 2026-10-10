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
  const hooks: SdkSessionHooks = {};
  const pre = isolate("onPreToolUse", config.onPreToolUse, onError);
  const preMcp = isolate("onPreMcpToolCall", config.onPreMcpToolCall, onError);
  const post = isolate("onPostToolUse", config.onPostToolUse, onError);
  const postFailure = isolate("onPostToolUseFailure", config.onPostToolUseFailure, onError);
  const userPrompt = isolate("onUserPromptSubmitted", config.onUserPromptSubmitted, onError);
  const sessionStart = isolate("onSessionStart", config.onSessionStart, onError);
  const sessionEnd = isolate("onSessionEnd", config.onSessionEnd, onError);
  const errorOccurred = isolate("onErrorOccurred", config.onErrorOccurred, onError);

  if (pre) {
    hooks.onPreToolUse = pre as SdkSessionHooks["onPreToolUse"];
  }
  if (preMcp) {
    hooks.onPreMcpToolCall = preMcp as SdkSessionHooks["onPreMcpToolCall"];
  }
  if (post) {
    hooks.onPostToolUse = post as SdkSessionHooks["onPostToolUse"];
  }
  if (postFailure) {
    hooks.onPostToolUseFailure = postFailure as SdkSessionHooks["onPostToolUseFailure"];
  }
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
  if (sessionStart) {
    hooks.onSessionStart = sessionStart as SdkSessionHooks["onSessionStart"];
  }
  if (sessionEnd) {
    hooks.onSessionEnd = sessionEnd as SdkSessionHooks["onSessionEnd"];
  }
  if (errorOccurred) {
    hooks.onErrorOccurred = errorOccurred as SdkSessionHooks["onErrorOccurred"];
  }

  return Object.keys(hooks).length > 0 ? hooks : undefined;
}
