import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type CliRunParams = Parameters<typeof import("../cli-runner.js").runCliAgent>[0];

const { runCliAgentMock } = vi.hoisted(() => ({
  runCliAgentMock: vi.fn(async (_params: CliRunParams) => undefined),
}));

vi.mock("../cli-runner.js", () => ({ runCliAgent: runCliAgentMock }));

const { compactNativeCliSession } = await import("./compact.js");

function compactParams() {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () =>
      [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          config: { command: "claude" },
          bundleMcp: false,
          pluginId: "anthropic",
          ownsNativeCompaction: true,
          manualCompaction: {
            buildPrompt: (instructions?: string) =>
              instructions ? `/compact ${instructions}` : "/compact",
            input: "arg",
            validateOutput: () => ({ ok: true }),
          },
        },
      ] as never,
    resolvePluginSetupCliBackend: () => undefined,
  });
  const dir = tempDirs.make("openclaw-compact-native-cli-");
  return {
    sessionId: "openclaw-session",
    sessionKey: "agent:main:main",
    sessionFile: "agent:main:main",
    agentId: "main",
    workspaceDir: join(dir, "workspace"),
    agentDir: join(dir, "agent"),
    config: {},
    provider: "anthropic",
    model: "opus",
    trigger: "manual",
    cliSessionBinding: { sessionId: "native-session", authProfileId: "anthropic:subscription" },
    sessionEntry: { execHost: "node", execNode: "paired-node" },
    customInstructions: "keep decisions",
  } as never;
}

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  runCliAgentMock.mockClear();
});

it("resumes the bound backend session with the backend-owned command", async () => {
  const result = await compactNativeCliSession({
    runtime: "claude-cli",
    compactParams: compactParams(),
  });

  expect(result).toEqual({
    ok: true,
    compacted: true,
    reason: 'CLI backend "claude-cli" compacted its native session.',
  });
  expect(runCliAgentMock).toHaveBeenCalledOnce();
  const call = runCliAgentMock.mock.calls[0]?.[0];
  expect(call).toMatchObject({
    preparedRunAdmission: {
      operationalRunInstance: {
        runId: "openclaw-session:native-compact",
      },
    },
    prompt: "/compact keep decisions",
    provider: "claude-cli",
    modelProvider: "anthropic",
    cliSessionId: "native-session",
    cliSessionBinding: { sessionId: "native-session", authProfileId: "anthropic:subscription" },
    authProfileId: "anthropic:subscription",
    sessionEntry: { execHost: "node", execNode: "paired-node" },
    controlOperation: "compact",
    disableCliLiveSession: true,
    cleanupCliLiveSessionOnRunEnd: true,
    allowEmptyAssistantReplyAsSilent: true,
  });
  const preparedRunAdmission = call?.preparedRunAdmission;
  if (!preparedRunAdmission) {
    throw new Error("native compaction did not prepare run admission");
  }
  await expect(preparedRunAdmission.admit("embedded")).rejects.toThrow(
    "prepared execution context is already closed",
  );
});
