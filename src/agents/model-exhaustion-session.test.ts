import { describe, expect, it, vi, beforeEach } from "vitest";
import { updateSessionStoreEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveStoredSessionKeyForSessionId } from "./command/session.js";
import { FailoverError } from "./failover-error.js";
import { runWithModelFallback } from "./model-fallback.js";

vi.mock("../config/sessions.js", () => ({
  updateSessionStoreEntry: vi.fn(),
}));

vi.mock("./command/session.js", () => ({
  resolveStoredSessionKeyForSessionId: vi.fn(),
}));

vi.mock("./auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSource: vi.fn(() => false),
}));

describe("model exhaustion session persistence", () => {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        modelExhaustionRetryMinutes: 10,
        model: {
          primary: "openai/gpt-4o",
          fallbacks: ["anthropic/claude-3-5-sonnet", "google/gemini-1.5-pro"],
        },
      },
    },
  } as any as OpenClawConfig;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips multiple exhausted models in the same session", async () => {
    const sessionId = "test-session";
    const sessionKey = "test-session-key";
    const storePath = "/tmp/test-sessions.json";
    const now = Date.now();
    const sessionAgentId = "agent-a";

    const exhaustedModels = {
      "openai/gpt-4o": now + 600000,
      "anthropic/claude-3-5-sonnet": now + 600000,
    };

    const sessionEntry = {
      sessionId,
      exhaustedModels,
    };

    (resolveStoredSessionKeyForSessionId as any).mockReturnValue({
      sessionKey,
      sessionStore: { [sessionKey]: sessionEntry },
      storePath,
    });

    const run = vi.fn().mockResolvedValue("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4o",
      sessionId,
      sessionAgentId,
      run,
    });

    expect(resolveStoredSessionKeyForSessionId).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        sessionId,
        agentId: sessionAgentId,
      }),
    );

    expect(result.result).toBe("ok");
    expect(result.provider).toBe("google");
    expect(result.model).toBe("gemini-1.5-pro");
    // Should have skipped gpt-4o and claude-3-5-sonnet
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("google", "gemini-1.5-pro");
  });

  it("records multiple exhausted models in the same session", async () => {
    const sessionId = "test-session";
    const sessionKey = "test-session-key";
    const storePath = "/tmp/test-sessions.json";

    (resolveStoredSessionKeyForSessionId as any).mockReturnValue({
      sessionKey,
      sessionStore: { [sessionKey]: { sessionId } },
      storePath,
    });

    const run = vi
      .fn()
      .mockRejectedValueOnce(
        new FailoverError("rate limit", {
          reason: "rate_limit",
          provider: "openai",
          model: "gpt-4o",
        }),
      )
      .mockResolvedValueOnce("ok");

    await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4o",
      sessionId,
      run,
    });

    expect(updateSessionStoreEntry).toHaveBeenCalled();
    const updateCall = (updateSessionStoreEntry as any).mock.calls[0][0];
    expect(updateCall.sessionKey).toBe(sessionKey);

    // Test the update function
    const entry = { sessionId };
    const updateResult = await updateCall.update(entry);
    expect(updateResult.exhaustedModels).toBeDefined();
    expect(updateResult.exhaustedModels["openai/gpt-4o"]).toBeGreaterThan(Date.now());
  });
});
