import { afterEach, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../plugins/hook-runner-global.js";
import { addTestHook } from "../../../plugins/hooks.test-helpers.js";
import { createOwnedTestInstance } from "../../../plugins/plugin-instance.test-support.js";
import { PluginInvocationScope } from "../../../plugins/plugin-invocation-scope.js";
import { resolveSubagentCompletionOrigin } from "./subagent-announce-origin.js";

// mock-isolation: No durable conversation binding exists; exercise the real hook fallback owner.
vi.mock("./subagent-announce-delivery.runtime.js", async () => {
  const { getGlobalHookRunner } = await import("../../../plugins/hook-runner-global.js");
  return {
    getGlobalHookRunner,
    resolveBoundDeliveryDestination: async () => undefined,
    resolveConversationIdFromTargets: () => "123",
  };
});

afterEach(() => resetGlobalHookRunner());

it("honors the Discord thread selected by a completion hook after the requester turn closes", async () => {
  const instance = createOwnedTestInstance("discord");
  const registry = instance.owner!.registry!;
  const threadOrigin = {
    channel: "discord",
    accountId: "work",
    to: "channel:777",
    threadId: "777",
  };
  addTestHook({
    registry,
    pluginId: "discord",
    hookName: "subagent_delivery_target",
    handler: instance.wrap(async () => ({ origin: threadOrigin })),
  });
  initializeGlobalHookRunner(registry);
  const requesterTurn = new PluginInvocationScope(registry, [instance], { retained: true });
  const origin = await requesterTurn.run(async () => {
    requesterTurn.release();
    return resolveSubagentCompletionOrigin({
      childSessionKey: "agent:test:subagent:child",
      requesterSessionKey: "agent:test:discord:channel:123",
      requesterOrigin: { channel: "discord", accountId: "work", to: "channel:123" },
      childRunId: "completed-child",
      expectsCompletionMessage: true,
    });
  });
  expect(origin).toEqual(threadOrigin);
});
