import { describe, expect, it, vi } from "vitest";
import { resolvePluginTurnContext } from "./plugin-turn-context.js";

describe("plugin turn context", () => {
  it("does not repeat turn-start work on a refresh continuation", async () => {
    const runAgentTurnPrepare = vi.fn(async () => ({ prependContext: "again" }));

    const result = await resolvePluginTurnContext({
      config: {},
      prompt: "original request",
      messages: [],
      hookCtx: { runId: "run-1", sessionKey: "agent:main:main", agentId: "main" },
      hookRunner: { hasHooks: () => true, runAgentTurnPrepare },
      refreshContinuation: true,
    });

    expect(result).toEqual({});
    expect(runAgentTurnPrepare).not.toHaveBeenCalled();
  });
});
