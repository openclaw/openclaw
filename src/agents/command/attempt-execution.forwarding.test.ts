import { beforeEach, describe, expect, it, vi } from "vitest";

const runEmbeddedPiAgentMock = vi.fn();

vi.mock("../pi-embedded.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

import { runAgentAttempt } from "./attempt-execution.js";

describe("runAgentAttempt embedded persistence forwarding", () => {
  beforeEach(() => {
    runEmbeddedPiAgentMock.mockReset();
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [],
      meta: { durationMs: 1, aborted: false, stopReason: "end_turn" },
    });
  });

  it("forwards retry persistence suppression and user-persist callback to the embedded runner", async () => {
    const onUserMessagePersisted = vi.fn();

    await runAgentAttempt({
      providerOverride: "openai",
      modelOverride: "mock-1",
      cfg: {} as never,
      sessionEntry: undefined,
      sessionId: "session:test",
      sessionKey: "agent:main:test",
      sessionAgentId: "main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      body: "retry body",
      isFallbackRetry: true,
      resolvedThinkLevel: "off",
      timeoutMs: 5_000,
      runId: "run:test",
      opts: {
        message: "retry body",
        senderIsOwner: true,
      },
      runContext: {},
      spawnedBy: undefined,
      messageChannel: "telegram",
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: "/tmp/agent",
      onAgentEvent: () => undefined,
      authProfileProvider: "openai",
      sessionHasHistory: true,
      suppressPromptPersistenceOnRetry: true,
      onUserMessagePersisted,
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const forwarded = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as
      | {
          suppressNextUserMessagePersistence?: boolean;
          onUserMessagePersisted?: () => void;
        }
      | undefined;
    expect(forwarded?.suppressNextUserMessagePersistence).toBe(true);
    expect(typeof forwarded?.onUserMessagePersisted).toBe("function");

    forwarded?.onUserMessagePersisted?.();
    expect(onUserMessagePersisted).toHaveBeenCalledTimes(1);
  });
});
