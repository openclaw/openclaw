import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { assert, expect, it, vi } from "vitest";
import plugin from "./index.js";

it("hands publication to the native owner and rejects model-selected accounts or sessions", async () => {
  const register = vi.fn<OpenClawPluginApi["registerTool"]>();
  const api = createTestPluginApi({ id: "gitlab", registerTool: register });
  plugin.register?.(api);
  const factory = register.mock.calls.find(
    ([, options]) => options?.name === "gitlab_publish",
  )?.[0];
  assert(factory && typeof factory === "object" && "create" in factory);
  const result = {
    content: [{ type: "text" as const, text: "accepted by host" }],
    details: { status: "started" },
  };
  const gatewayHandoff = vi.fn(async () => result);
  const tool = factory.create({
    sessionKey: "agent:main:dashboard:alice",
    sessionId: "conversation-a",
    agentId: "main",
    runId: "run-a",
    assertInvocationCurrent() {},
    gatewayHandoff,
  });
  assert(tool && !Array.isArray(tool));
  expect(
    await tool.execute("call-a", {
      action: "publish",
      draft: true,
      bootstrapDraft: true,
      baseBranch: "develop",
      workspacePath: "/synthetic/checkout",
    }),
  ).toBe(result);
  expect(gatewayHandoff).toHaveBeenCalledWith({
    method: "tools.gitlab.publication.publish",
    params: {
      sessionKey: "agent:main:dashboard:alice",
      agentId: "main",
      idempotencyKey: "run-a:call-a",
      operation: {
        action: "publish",
        draft: true,
        bootstrapDraft: true,
        baseBranch: "develop",
        workspacePath: "/synthetic/checkout",
      },
    },
    signal: undefined,
  });
  for (const forbidden of [
    { selection: { source: "shared" } },
    { sessionKey: "agent:main:dashboard:bob" },
    { profileId: "bob" },
  ]) {
    await expect(tool.execute("call-b", { action: "publish", ...forbidden })).rejects.toThrow(
      "current signed-in Gateway conversation",
    );
  }
  expect(gatewayHandoff).toHaveBeenCalledTimes(1);
});
