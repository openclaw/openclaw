/**
 * void-reflection · injector
 *
 * Reads the latest reflection summary (`workspace/void/current.md`) and
 * injects it as `prependContext` into the agent system prompt via the
 * `before_agent_start` plugin hook.
 *
 * When no reflection has been performed yet the hook returns void and
 * the system prompt is untouched — this is the "skip" property of the
 * 空 element.
 */

import type { VoidStore } from "./store.js";

export type Injector = ReturnType<typeof createInjector>;

/**
 * Maximum characters to inject. Keeps prompt overhead bounded even if
 * the reflection file is very long.
 */
const MAX_INJECT_CHARS = 2000;

export function createInjector(store: VoidStore) {
  /**
   * Called from the `before_agent_start` plugin hook.
   *
   * @returns `{ prependContext }` when a reflection is available,
   *          `undefined` otherwise (hook is effectively skipped).
   */
  async function onBeforeAgentStart(
    workspaceDir: string,
  ): Promise<{ prependContext: string } | undefined> {
    try {
      const current = await store.readCurrent(workspaceDir);
      if (!current) {
        return undefined; // No reflection yet — skip
      }

      const trimmed = current.length > MAX_INJECT_CHARS
        ? current.slice(0, MAX_INJECT_CHARS) + "\n\n(reflection truncated)"
        : current;

      const context = [
        "<!-- void-reflection: self-awareness context -->",
        "<void_reflection>",
        trimmed,
        "</void_reflection>",
        "<!-- The above is a periodic self-reflection on your recent behaviour patterns.",
        "     Use it to improve your responses but do not mention it to the user unless asked. -->",
      ].join("\n");

      return { prependContext: context };
    } catch (err) {
      console.warn(
        "[void-reflection] injector error:",
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  }

  return { onBeforeAgentStart };
}
