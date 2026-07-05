/**
<<<<<<< HEAD
 * Compatibility adapter for native Copilot SDK SessionHooks.
 *
 * `hooksConfig` is a shipped Copilot-specific per-attempt API. It remains
 * separate from OpenClaw's generic lifecycle hooks because the SDK callbacks
 * expose native events and decisions that the portable hook contract does not.
 */
import type { SessionConfig } from "@github/copilot-sdk";

type SdkSessionHooks = NonNullable<SessionConfig["hooks"]>;
type PreToolUseHandler = NonNullable<SdkSessionHooks["onPreToolUse"]>;
type PreMcpToolCallHandler = NonNullable<SdkSessionHooks["onPreMcpToolCall"]>;
type PostToolUseHandler = NonNullable<SdkSessionHooks["onPostToolUse"]>;
type PostToolUseFailureHandler = NonNullable<SdkSessionHooks["onPostToolUseFailure"]>;
=======
 * Hooks bridge for the copilot agent runtime.
 *
 * BACK-POINTER: The host-side hook runner lives outside this package
 * boundary in `src/agents/harness/lifecycle-hook-helpers.ts` (uses the
 * plugin hook runner via `src/plugins/hook-runner-global.ts`). Per
 * proposal §266 (todo `hooks-bridge`), this module provides a small
 * contract surface that mirrors the SDK's `SessionHooks` shape; the
 * core wiring layer constructs handlers that call into
 * `runAgentHarnessLlmInputHook`, `runAgentHarnessLlmOutputHook`,
 * `runAgentHarnessAgentEndHook`, etc., and threads them through
 * `AttemptParamsLike.hooks`.
 *
 * Cross-package boundary note: the heavy host lifecycle helpers
 * cannot be imported here (`tsconfig.package-boundary.base.json`). The
 * bridge keeps the SDK hook contracts intact, wraps each provided
 * handler in an error-isolating envelope so a thrown host hook cannot
 * crash the SDK session, and returns a `SessionHooks` object that
 * `createSessionConfig` can plug into `SessionConfig.hooks`.
 *
 * Note on default omission: if no handlers are supplied, the bridge
 * returns `undefined` so that `SessionConfig.hooks` stays absent and
 * the SDK skips the entire hook subsystem (matches the "no hooks
 * installed" runtime behaviour the harness had pre-bridge).
 */

import type { SessionConfig } from "@github/copilot-sdk";

// All hook handler types are derived from SessionHooks so this bridge
// stays pinned to the same SDK source the rest of the harness uses,
// without depending on the SDK re-exporting individual handler aliases
// (which it does not, as of @github/copilot-sdk@1.0.0-beta.4).
type SdkSessionHooks = NonNullable<SessionConfig["hooks"]>;
type PreToolUseHandler = NonNullable<SdkSessionHooks["onPreToolUse"]>;
type PostToolUseHandler = NonNullable<SdkSessionHooks["onPostToolUse"]>;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
type UserPromptSubmittedHandler = NonNullable<SdkSessionHooks["onUserPromptSubmitted"]>;
type SessionStartHandler = NonNullable<SdkSessionHooks["onSessionStart"]>;
type SessionEndHandler = NonNullable<SdkSessionHooks["onSessionEnd"]>;
type ErrorOccurredHandler = NonNullable<SdkSessionHooks["onErrorOccurred"]>;

<<<<<<< HEAD
export interface CopilotHooksBridgeOptions {
  onUserPromptSubmitted?: (submission: { prompt: string; additionalContext?: string }) => void;
}

export interface CopilotHooksConfig {
  onPreToolUse?: PreToolUseHandler;
  onPreMcpToolCall?: PreMcpToolCallHandler;
  onPostToolUse?: PostToolUseHandler;
  onPostToolUseFailure?: PostToolUseFailureHandler;
=======
export interface CopilotHooksConfig {
  onPreToolUse?: PreToolUseHandler;
  onPostToolUse?: PostToolUseHandler;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  onUserPromptSubmitted?: UserPromptSubmittedHandler;
  onSessionStart?: SessionStartHandler;
  onSessionEnd?: SessionEndHandler;
  onErrorOccurred?: ErrorOccurredHandler;
  /**
<<<<<<< HEAD
   * Called when a native SDK hook handler throws. Defaults to console.warn so
   * native hook failures do not terminate the SDK session.
=======
   * Optional hook-error notifier. Called whenever any wrapped handler
   * throws (synchronously or as a Promise rejection). Defaults to
   * `console.warn` so the failure is visible to operators without
   * crashing the SDK session. Receives the SDK hook name and the
   * raised error.
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
<<<<<<< HEAD
 * Wrap a native handler so it cannot throw into the SDK. Returning undefined
 * leaves the SDK's default decision in place.
=======
 * Wrap a host handler in an error-isolating envelope so it cannot
 * throw out into the SDK. Returns `undefined` (no opinion) when the
 * host handler throws, so the SDK falls back to its default behaviour
 * for that hook.
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
<<<<<<< HEAD
        // Never let the error notifier itself throw into the SDK.
=======
        // never let the error notifier itself throw out
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      }
      return undefined;
    }
  };
}

/**
<<<<<<< HEAD
 * Build an SDK-shaped hook object from native per-attempt configuration.
 * Omit the SDK hook subsystem when no handlers were configured.
 */
export function createHooksBridge(
  config?: CopilotHooksConfig,
  options?: CopilotHooksBridgeOptions,
): SdkSessionHooks | undefined {
=======
 * Build an SDK-shaped `SessionHooks` object from a host-supplied
 * `CopilotHooksConfig`. Returns `undefined` when no handlers were
 * supplied so the SDK skips the hook subsystem entirely.
 */
export function createHooksBridge(config?: CopilotHooksConfig): SdkSessionHooks | undefined {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  if (!config) {
    return undefined;
  }
  const onError = config.onHookError ?? DEFAULT_HOOK_ERROR_HANDLER;
  const hooks: SdkSessionHooks = {};
  const pre = isolate("onPreToolUse", config.onPreToolUse, onError);
<<<<<<< HEAD
  const preMcp = isolate("onPreMcpToolCall", config.onPreMcpToolCall, onError);
  const post = isolate("onPostToolUse", config.onPostToolUse, onError);
  const postFailure = isolate("onPostToolUseFailure", config.onPostToolUseFailure, onError);
=======
  const post = isolate("onPostToolUse", config.onPostToolUse, onError);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  const userPrompt = isolate("onUserPromptSubmitted", config.onUserPromptSubmitted, onError);
  const sessionStart = isolate("onSessionStart", config.onSessionStart, onError);
  const sessionEnd = isolate("onSessionEnd", config.onSessionEnd, onError);
  const errorOccurred = isolate("onErrorOccurred", config.onErrorOccurred, onError);

  if (pre) {
    hooks.onPreToolUse = pre as PreToolUseHandler;
  }
<<<<<<< HEAD
  if (preMcp) {
    hooks.onPreMcpToolCall = preMcp as PreMcpToolCallHandler;
  }
  if (post) {
    hooks.onPostToolUse = post as PostToolUseHandler;
  }
  if (postFailure) {
    hooks.onPostToolUseFailure = postFailure as PostToolUseFailureHandler;
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
=======
  if (post) {
    hooks.onPostToolUse = post as PostToolUseHandler;
  }
  if (userPrompt) {
    hooks.onUserPromptSubmitted = userPrompt as UserPromptSubmittedHandler;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  }
  if (sessionStart) {
    hooks.onSessionStart = sessionStart as SessionStartHandler;
  }
  if (sessionEnd) {
    hooks.onSessionEnd = sessionEnd as SessionEndHandler;
  }
  if (errorOccurred) {
    hooks.onErrorOccurred = errorOccurred as ErrorOccurredHandler;
  }

<<<<<<< HEAD
  return Object.keys(hooks).length > 0 ? hooks : undefined;
=======
  if (Object.keys(hooks).length === 0) {
    return undefined;
  }
  return hooks;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}
