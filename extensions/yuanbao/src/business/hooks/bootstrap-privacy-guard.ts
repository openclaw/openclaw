/**
 * Bootstrap privacy guard hook.
 *
 * In group chat scenarios, removes USER.md from the bootstrap file list
 * to prevent private info from being leaked via prompt injection.
 */

import {
  registerInternalHook,
  isAgentBootstrapEvent,
  type AgentBootstrapHookContext,
} from "openclaw/plugin-sdk/hook-runtime";

/** Group chat sessionKey marker */
const GROUP_SESSION_KEY_MARKER = ":group:";

/** Bootstrap filenames to exclude in group chat (contain private info or AI memory) */
const GROUP_EXCLUDED_FILENAMES = new Set(["USER.md", "MEMORY.md", "memory.md"]);

/**
 * Register agent:bootstrap internal hook — group chat privacy guard.
 *
 * Called by {@link registerYuanbaoHooks}; no longer relies on side-effect import.
 */
export function registerBootstrapPrivacyGuard(): void {
  registerInternalHook("agent:bootstrap", (event) => {
    // Type guard: confirm agent:bootstrap event
    if (!isAgentBootstrapEvent(event)) {
      return;
    }

    const context = event.context as AgentBootstrapHookContext;
    const sessionKey = context.sessionKey ?? "";

    // Only apply to group chat sessions
    if (!sessionKey.includes(GROUP_SESSION_KEY_MARKER)) {
      return;
    }

    // Remove sensitive files from bootstrapFiles
    context.bootstrapFiles = context.bootstrapFiles.filter(
      (file) => !GROUP_EXCLUDED_FILENAMES.has(file.name),
    );
  });
}
