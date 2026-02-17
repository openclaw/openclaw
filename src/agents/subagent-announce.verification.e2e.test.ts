import { beforeEach, describe, expect, it, vi } from "vitest";

const agentCalls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
const sessionsDeleteSpy = vi.fn();
const readLatestAssistantReplyMock = vi.fn(async () => "plain run output");
const runVerificationChecksMock = vi.fn();
const spawnCoreMock = vi.fn();

let sessionStore: Record<string, Record<string, unknown>> = {};
let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (req: unknown) => {
    const typed = req as { method?: string; params?: Record<string, unknown> };
    if (typed.method === "agent") {
      agentCalls.push(typed);
      return { status: "ok" };
    }
    if (typed.method === "agent.wait") {
      return { status: "ok", startedAt: 10, endedAt: 20 };
    }
    if (typed.method === "sessions.patch") {
      return {};
    }
    if (typed.method === "sessions.delete") {
      sessionsDeleteSpy(typed);
      return {};
    }
    return {};
  }),
}));

vi.mock("./tools/agent-step.js", () => ({
  readLatestAssistantReply: readLatestAssistantReplyMock,
}));

vi.mock("./spawn-verification.js", () => ({
  runSpawnVerificationChecks: (...args: unknown[]) => runVerificationChecksMock(...args),
}));

vi.mock("./spawn-core.js", () => ({
  spawnCore: (...args: unknown[]) => spawnCoreMock(...args),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => sessionStore),
  resolveAgentIdFromSessionKey: () => "main",
  resolveStorePath: () => "/tmp/sessions.json",
  resolveMainSessionKey: () => "agent:main:main",
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
  };
});

vi.mock("./pi-embedded.js", () => ({
  isEmbeddedPiRunActive: vi.fn(() => false),
  queueEmbeddedPiMessage: vi.fn(() => false),
  waitForEmbeddedPiRunEnd: vi.fn(async () => true),
}));

describe("subagent announce verification integration", () => {
  beforeEach(async () => {
    const { resetSubagentRegistryForTests } = await import("./subagent-registry.js");
    resetSubagentRegistryForTests({ persist: false });
    agentCalls.length = 0;
    sessionsDeleteSpy.mockReset();
    readLatestAssistantReplyMock.mockReset().mockResolvedValue("plain run output");
    runVerificationChecksMock.mockReset().mockResolvedValue({
      status: "skipped",
      checks: [],
      verifiedAt: 1700000000000,
    });
    spawnCoreMock.mockReset().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:retry",
      runId: "retry-run-1",
    });
    sessionStore = {};
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
  });

  it("enforces requireCompletionReport and records failed verification details", async () => {
    const { addSubagentRunForTests, getRunById } = await import("./subagent-registry.js");
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");

    addSubagentRunForTests({
      runId: "run-verify-require-report",
      childSessionKey: "agent:main:subagent:verify-report",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "verify report",
      cleanup: "keep",
      createdAt: Date.now(),
      verification: {
        requireCompletionReport: true,
        onFailure: "fail",
      },
      verificationState: "pending",
      originalSpawnParams: {
        verification: {
          requireCompletionReport: true,
          onFailure: "fail",
        },
      },
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:verify-report",
      childRunId: "run-verify-require-report",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "verify report",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    expect(runVerificationChecksMock).toHaveBeenCalledTimes(1);
    const updated = getRunById("run-verify-require-report");
    expect(updated?.verificationState).toBe("failed");
    expect(updated?.verificationResult?.status).toBe("failed");
    expect(updated?.verificationResult?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "completion_report",
          passed: false,
          reason: "completion_report_missing",
        }),
      ]),
    );

    const message = String(agentCalls.at(-1)?.params?.message ?? "");
    expect(message).toContain("failed verification");
    expect(message).toContain("completion_report_missing");
    expect(sessionsDeleteSpy).not.toHaveBeenCalled();
  });

  it("runs retry_once exactly once and stores retryAttemptedAt", async () => {
    const { addSubagentRunForTests, getRunById } = await import("./subagent-registry.js");
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");

    runVerificationChecksMock.mockResolvedValue({
      status: "failed",
      checks: [
        {
          type: "artifact",
          target: "/tmp/out.json",
          passed: false,
          reason: "artifact_not_found",
        },
      ],
      verifiedAt: 1700000000000,
    });

    addSubagentRunForTests({
      runId: "run-verify-retry",
      childSessionKey: "agent:main:subagent:verify-retry",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "verify retry",
      cleanup: "keep",
      createdAt: Date.now(),
      verification: {
        onFailure: "retry_once",
      },
      verificationState: "pending",
      originalSpawnParams: {
        verification: {
          onFailure: "retry_once",
        },
      },
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:verify-retry",
      childRunId: "run-verify-retry",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "verify retry",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    expect(spawnCoreMock).toHaveBeenCalledTimes(1);
    const updated = getRunById("run-verify-retry");
    expect(typeof updated?.retryAttemptedAt).toBe("number");
    expect(updated?.verificationState).toBe("failed");
    const message = String(agentCalls.at(-1)?.params?.message ?? "");
    expect(message).toContain("retry started");
    expect(message).toContain("retry-run-1");

    agentCalls.length = 0;
    spawnCoreMock.mockReset();
    const didAnnounceSecond = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:verify-retry",
      childRunId: "run-verify-retry",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "verify retry",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      outcome: { status: "ok" },
    });

    expect(didAnnounceSecond).toBe(true);
    expect(spawnCoreMock).not.toHaveBeenCalled();
    const secondMessage = String(agentCalls.at(-1)?.params?.message ?? "");
    expect(secondMessage).toContain("already attempted");
  });
});
