import "./pi-embedded-runner/run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { classifyFailoverReason, isFailoverErrorMessage } from "./pi-embedded-helpers.js";
import { runEmbeddedPiAgent } from "./pi-embedded-runner/run.js";
import { makeAttemptResult } from "./pi-embedded-runner/run.overflow-compaction.fixture.js";
import { mockedRunEmbeddedAttempt } from "./pi-embedded-runner/run.overflow-compaction.shared-test.js";

const mockedClassifyFailoverReason = vi.mocked(classifyFailoverReason);
const mockedIsFailoverErrorMessage = vi.mocked(isFailoverErrorMessage);

describe("runEmbeddedPiAgent API error notices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedClassifyFailoverReason.mockReturnValue("overloaded");
    mockedIsFailoverErrorMessage.mockReturnValue(true);
  });

  it("uses agent-level tool overrides when deciding whether to notify the user", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: new Error("overloaded_error"),
        assistantTexts: [],
      }),
    );

    const onBlockReply = vi.fn();
    const config: OpenClawConfig = {
      tools: {
        notifyUserOnApiError: false,
      },
      agents: {
        defaults: {
          model: {
            primary: "anthropic/test-model",
            fallbacks: ["anthropic/test-fallback"],
          },
        },
        list: [
          {
            id: "support",
            tools: {
              notifyUserOnApiError: true,
            },
          },
        ],
      },
    };

    await expect(
      runEmbeddedPiAgent({
        sessionId: "test-session",
        sessionKey: "agent:support:api-notice",
        sessionFile: "/tmp/session.json",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        timeoutMs: 30_000,
        runId: "run-api-notice",
        config,
        onBlockReply,
        agentId: "support",
      }),
    ).rejects.toThrow("overloaded_error");

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toContain("temporary error");
  });
});
