import { AsyncLocalStorage } from "node:async_hooks";
import type { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { normalizeToolPolicyName } from "./tool-policy.js";

type HookRunner = NonNullable<ReturnType<typeof getGlobalHookRunner>>;
type AuthorizedPromptBuildArgs = Parameters<HookRunner["runAuthorizedPromptBuild"]>;
type AuthorizedPromptBuildResult = Awaited<ReturnType<HookRunner["runAuthorizedPromptBuild"]>>;

const turnResults = new AsyncLocalStorage<
  WeakMap<HookRunner, Map<string, Promise<AuthorizedPromptBuildResult>>>
>();

/** Fallback candidates of one logical turn share its authorized prompt enrichment. */
export function withAuthorizedPromptBuildTurn<T>(run: () => Promise<T>): Promise<T> {
  return turnResults.run(new WeakMap(), run);
}

/**
 * Runs authorized `before_prompt_build` once per logical turn. A later candidate with the
 * same request and tool surface reuses the first result instead of repeating plugin side
 * effects; its own continuity is not reported. The route fingerprint stays out of the key
 * because the authority a handler can observe is the tool list, not the route.
 */
export function runAuthorizedPromptBuildForTurn(
  hookRunner: HookRunner,
  ...[event, ctx, params]: AuthorizedPromptBuildArgs
): Promise<AuthorizedPromptBuildResult> {
  const run = () => hookRunner.runAuthorizedPromptBuild(event, ctx, params);
  const store = turnResults.getStore();
  if (!store) {
    return run();
  }
  const key = JSON.stringify([
    ctx.agentId,
    ctx.sessionKey,
    ctx.sessionId,
    event.currentUserMessageId,
    event.prompt,
    [...new Set(params.activeToolNames.map(normalizeToolPolicyName))].toSorted(),
  ]);
  let results = store.get(hookRunner);
  if (!results) {
    results = new Map();
    store.set(hookRunner, results);
  }
  const existing = results.get(key);
  if (existing) {
    return existing.then((result) => {
      params.assertHostActive();
      return result;
    });
  }
  const pending = run();
  results.set(key, pending);
  pending.catch(() => {
    if (results.get(key) === pending) {
      results.delete(key);
    }
  });
  return pending;
}
