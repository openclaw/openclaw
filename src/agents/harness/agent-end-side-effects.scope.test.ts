import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createHookRunner } from "../../plugins/hooks.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createOwnedInstance } from "../../plugins/plugin-instance.test-support.js";
import { PluginInvocationScope } from "../../plugins/plugin-invocation-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runAgentEndSideEffectsAsync } from "./agent-end-side-effects.js";
import { bindAgentHarnessHookMessages } from "./lifecycle-hook-messages.js";

it("admits terminal handlers before releasing the turn scope after delayed hydration", async () => {
  const plugins = [createOwnedInstance("plugin-a"), createOwnedInstance("plugin-b")];
  const finishHooks = createDeferredCore();
  const loadStarted = createDeferredCore();
  const messages = createDeferredCore<unknown[]>();
  const hydrated = [{ role: "assistant", content: "nested tool result" }];
  const handlers = plugins.map(({ instance }) => {
    const handler = vi.fn(async (_event: unknown, _ctx: unknown) => {
      await finishHooks.promise;
    });
    return { handler, wrapped: instance.wrap(handler), pluginId: instance.pluginId };
  });
  const registry = createMockPluginRegistry(
    handlers.map(({ wrapped, pluginId }) => ({
      pluginId,
      hookName: "agent_end",
      conversationAccessAllowed: true,
      handler: wrapped,
    })),
  );
  const scope = new PluginInvocationScope(
    registry,
    plugins.map(({ instance }) => instance),
    {
      registryByInstance: new Map(
        plugins.map(({ instance, registry: ownedRegistry }) => [instance, ownedRegistry]),
      ),
    },
  );
  const runner = createHookRunner(registry, { logger: { warn: vi.fn(), error: vi.fn() } });
  const turn = scope.run(async () => {
    try {
      await runAgentEndSideEffectsAsync({
        event: bindAgentHarnessHookMessages({ messages: [], success: true }, () => {
          loadStarted.resolve();
          return messages.promise;
        }),
        ctx: { runId: "delayed-terminal-run" },
        hookRunner: runner,
      });
    } finally {
      scope.release();
    }
  });
  try {
    await loadStarted.promise;
    // Let foreground cleanup run if terminal preparation incorrectly returned early.
    await nextTurn();
    messages.resolve(hydrated);
    await turn;
    await nextTurn();
    for (const { handler } of handlers) {
      expect(handler).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ messages: hydrated, success: true }),
        expect.objectContaining({ runId: "delayed-terminal-run" }),
      );
    }
    // The turn completed while both handlers are still pending, without reopening admission.
    expect(() => scope.run(() => {})).toThrow("Plugin invocation scope is closed");
  } finally {
    messages.resolve(hydrated);
    finishHooks.resolve();
    await turn;
    scope.release();
    await Promise.all(plugins.map(({ instance }) => instance.dispose()));
  }
});

it("does not hydrate terminal messages without subscribers", async () => {
  const load = vi.fn(async () => []);
  await runAgentEndSideEffectsAsync({
    event: bindAgentHarnessHookMessages({ messages: [], success: true }, load),
    ctx: { runId: "no-terminal-hooks" },
    hookRunner: createHookRunner(createMockPluginRegistry([])),
  });
  expect(load).not.toHaveBeenCalled();
});

it("keeps hydration failure observational and skips terminal handlers", async () => {
  const handler = vi.fn();
  const hookRunner = createHookRunner(
    createMockPluginRegistry([{ hookName: "agent_end", handler }]),
  );
  await expect(
    runAgentEndSideEffectsAsync({
      event: bindAgentHarnessHookMessages({ messages: [], success: true }, async () => {
        throw new Error("nested activity reader no longer owns this session");
      }),
      ctx: { runId: "failed-terminal-read" },
      hookRunner,
    }),
  ).resolves.toBeUndefined();
  expect(handler).not.toHaveBeenCalled();
});
