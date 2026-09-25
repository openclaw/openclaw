/**
 * Codex app-server extension runner.
 *
 * Harness integration uses this to let registered extensions observe and adjust
 * tool results before they are returned to the agent runtime.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { listCodexAppServerExtensionFactories } from "../../plugins/codex-app-server-extension-factory.js";
import type {
  CodexAppServerExtensionContext,
  CodexAppServerExtensionFactory,
  CodexAppServerExtensionRuntime,
  CodexAppServerToolResultEvent,
} from "../../plugins/codex-app-server-extension-types.js";
import { getPluginValueInstance } from "../../plugins/plugin-instance-scope.js";
import type { AgentToolResult } from "../runtime/index.js";

const log = createSubsystemLogger("agents/harness");

type CodexToolResultHandler = Parameters<CodexAppServerExtensionRuntime["on"]>[1];

/** Creates a runner that applies registered Codex app-server tool-result extensions. */
export function createCodexAppServerToolResultExtensionRunner(
  ctx: CodexAppServerExtensionContext,
  factories: CodexAppServerExtensionFactory[] = listCodexAppServerExtensionFactories(),
) {
  const handlers: CodexToolResultHandler[] = [];
  const initPromise = (async () => {
    for (const factory of factories) {
      const instance = getPluginValueInstance(factory);
      await factory({
        on(event, handler) {
          if (event === "tool_result") {
            // Retained registrations and callbacks belong to the exact factory instance.
            if (instance) {
              instance.run(() => handlers.push(instance.wrap(handler)));
            } else {
              handlers.push(handler);
            }
          }
        },
      });
    }
  })();

  return {
    async applyToolResultExtensions(
      event: CodexAppServerToolResultEvent,
    ): Promise<AgentToolResult<unknown>> {
      await initPromise;
      let current = event.result;
      for (const handler of handlers) {
        try {
          const next = await handler({ ...event, result: current }, ctx);
          if (next?.result) {
            current = next.result;
          }
        } catch (error) {
          // Extensions are advisory; one failing handler must not discard the
          // current tool result or block later handlers.
          const detail = error instanceof Error ? error.message : String(error);
          log.warn(`[codex] tool_result extension failed for ${event.toolName}: ${detail}`);
        }
      }
      return current;
    },
  };
}
