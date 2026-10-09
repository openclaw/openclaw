import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { closeAuthProfileReadPool } from "../auth-profiles/sqlite.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import {
  makeRunAgentAttemptParams,
  makeSessionEntry,
  type RunAgentAttemptOverrides,
} from "./attempt-execution.cli.test-support.js";
import { runAgentAttempt as runAgentAttemptImpl } from "./attempt-execution.js";

const runCliAgentMock = vi.hoisted(() => vi.fn());
const runEmbeddedAgentMock = vi.hoisted(() => vi.fn());
const hasClaudeSessionMock = vi.hoisted(() => vi.fn(() => false));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// mock-isolation: Capture candidate parameters without starting an external CLI provider.
vi.mock("../cli-runner.js", () => ({ runCliAgent: runCliAgentMock }));

// mock-isolation: This fixture must not read or reuse live CLI session state.
vi.mock("../cli-runner/cli-live-session-registry.js", () => ({
  getCliLiveSessionGeneration: vi.fn(() => undefined),
  hasCliLiveSession: hasClaudeSessionMock,
}));

vi.mock("../model-selection.js", async () => ({
  ...(await vi.importActual<typeof import("../model-selection.js")>("../model-selection.js")),
  isCliProvider: (provider: string, _cfg?: OpenClawConfig) => {
    const normalized = provider.trim().toLowerCase();
    return (
      normalized === "claude-cli" ||
      normalized === "codex-cli" ||
      normalized === "google-gemini-cli"
    );
  },
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("../model-runtime-aliases.js", async () => {
  const actual = await vi.importActual<typeof import("../model-runtime-aliases.js")>(
    "../model-runtime-aliases.js",
  );
  return {
    ...actual,
    resolveCliRuntimeExecutionProvider: ({
      provider,
      cfg,
      modelId,
    }: {
      provider?: string;
      cfg?: OpenClawConfig;
      modelId?: string;
    }) => {
      const key = provider && modelId ? `${provider}/${modelId}` : undefined;
      const runtime = key
        ? cfg?.agents?.defaults?.models?.[key]?.agentRuntime?.id?.trim()
        : undefined;
      return runtime || provider;
    },
  };
});

// mock-isolation: Capture host run options without executing a model or creating agent resources.
vi.mock("../embedded-agent.js", () => ({ runEmbeddedAgent: runEmbeddedAgentMock }));

const runAgentAttempt = (params: RunAgentAttemptOverrides) =>
  runAgentAttemptImpl(makeRunAgentAttemptParams(params));
const requireRecord = createRequireRecord("object", "label-not-object");

function expectMockArgFields(fields: Record<string, unknown>) {
  const arg = runEmbeddedAgentMock.mock.calls[0]?.[0];
  const record = requireRecord(arg, "embedded run options");
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

describe("embedded attempt thinking provenance", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = tempDirs.make("openclaw-embedded-attempt-");
    runCliAgentMock.mockReset();
    runEmbeddedAgentMock.mockReset();
  });

  afterEach(async () => {
    closeAuthProfileReadPool({ kind: "root", rootPath: tmpDir });
    await cleanupSessionStateForTest({ stateDir: tmpDir });
  });

  it("keeps a known model-default level on the direct OpenClaw harness", async () => {
    const sessionEntry = makeSessionEntry("explicit-openclaw-session", {
      agentRuntimeOverride: "openclaw",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      pluginOwnerId: "model-owner",
    });
    const modelThinkingCapability = {
      provider: "openai",
      modelId: "gpt-5.6-sol",
      agentRuntime: "openclaw",
      route: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
      compat: {
        thinkingFormat: "openai",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
    } as const;
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runAgentAttempt({
      sessionKey: "agent:main:main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      modelOverride: "gpt-5.6-sol",
      modelThinkingCapability,
      sessionEntry,
      agentHarnessRuntimeOverride: "openclaw",
      resolvedThinkLevel: "max",
      thinkingExplicit: false,
      runId: "run-explicit-openclaw-runtime",
      sessionHasHistory: true,
    });

    expect(runCliAgentMock).not.toHaveBeenCalled();
    expectMockArgFields({
      provider: "openai",
      model: "gpt-5.6-sol",
      modelThinkingCapability,
      agentHarnessId: undefined,
      agentHarnessRuntimeOverride: "openclaw",
      thinkLevel: "max",
      thinkingExplicit: false,
    });
  });
});
