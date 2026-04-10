import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  getRequiredHookHandler,
  registerHookHandlersForTest,
} from "../../../test/helpers/plugins/subagent-hooks.js";

let registerSlackSubagentHooks: typeof import("./subagent-hooks.js").registerSlackSubagentHooks;

function registerHandlersForTest(config: Record<string, unknown> = {}) {
  return registerHookHandlersForTest<OpenClawPluginApi>({
    config,
    register: registerSlackSubagentHooks,
  });
}

describe("slack subagent hook handlers", () => {
  beforeAll(async () => {
    ({ registerSlackSubagentHooks } = await import("./subagent-hooks.js"));
  });

  it("marks thread routing ready on subagent_spawning for slack threads", () => {
    const handlers = registerHandlersForTest();
    const handler = getRequiredHookHandler(handlers, "subagent_spawning");

    expect(
      handler(
        {
          childSessionKey: "agent:main:subagent:child",
          requester: {
            channel: "slack",
            accountId: "default",
            to: "channel:C123",
            threadId: "1775841953.287659",
          },
          threadRequested: true,
        },
        {},
      ),
    ).toMatchObject({ status: "ok", threadBindingReady: true });
  });

  it("returns the originating slack thread as the delivery target", () => {
    const handlers = registerHandlersForTest();
    const handler = getRequiredHookHandler(handlers, "subagent_delivery_target");

    expect(
      handler(
        {
          childSessionKey: "agent:main:subagent:child",
          expectsCompletionMessage: true,
          requesterOrigin: {
            channel: "slack",
            accountId: "default",
            to: "channel:C123",
            threadId: "1775841953.287659",
          },
        },
        {},
      ),
    ).toEqual({
      origin: {
        channel: "slack",
        accountId: "default",
        to: "channel:C123",
        threadId: "1775841953.287659",
      },
    });
  });

  it("returns undefined when slack delivery is missing thread context", () => {
    const handlers = registerHandlersForTest();
    const handler = getRequiredHookHandler(handlers, "subagent_delivery_target");

    expect(
      handler(
        {
          childSessionKey: "agent:main:subagent:child",
          expectsCompletionMessage: true,
          requesterOrigin: {
            channel: "slack",
            accountId: "default",
            to: "channel:C123",
          },
        },
        {},
      ),
    ).toBeUndefined();
  });
});
