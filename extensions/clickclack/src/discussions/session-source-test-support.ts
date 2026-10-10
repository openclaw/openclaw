import { isDeepStrictEqual } from "node:util";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

type SessionBindingRuntime = typeof import("openclaw/plugin-sdk/session-binding-runtime");
let nextPath = 0;
const runtimes = new Map<string, PluginRuntime>();

export function bindDiscussionSessionFixture(runtime: PluginRuntime): void {
  const preparationPath = `/clickclack-test/${++nextPath}`;
  runtime.agent.session.resolveStorePath = () => preparationPath;
  runtimes.set(preparationPath, runtime);
}

export function createDiscussionSessionRuntimeMock(actual: SessionBindingRuntime) {
  return {
    ...actual,
    captureSessionEntryCurrentCheck: async (
      params: Parameters<SessionBindingRuntime["captureSessionEntryCurrentCheck"]>[0],
    ) => {
      const runtime = params.storePath && runtimes.get(params.storePath);
      if (!runtime) {
        return actual.captureSessionEntryCurrentCheck(params);
      }
      const entry = runtime.agent.session.getSessionEntryAsync
        ? await runtime.agent.session.getSessionEntryAsync(params)
        : runtime.agent.session.getSessionEntry(params);
      const fields = [
        ...(params.matchGeneration === false ? [] : (["sessionId", "lifecycleRevision"] as const)),
        ...(params.fields ?? []),
      ];
      const expected = structuredClone(entry);
      const isCurrent = () => {
        const current = runtime.agent.session.getSessionEntry(params);
        return (
          params.isActive?.() !== false &&
          (current === undefined) === (expected === undefined) &&
          fields.every((field) =>
            isDeepStrictEqual(
              current ? Reflect.get(current, field) : undefined,
              expected ? Reflect.get(expected, field) : undefined,
            ),
          )
        );
      };
      const assertCurrent = () => {
        if (!isCurrent()) {
          throw new Error(params.errorMessage);
        }
      };
      assertCurrent();
      return { entry, isCurrent, assertCurrent };
    },
  };
}
