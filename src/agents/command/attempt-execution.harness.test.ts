import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCommandAuthorizationAsync } from "../../auto-reply/command-auth.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createOAuthRefreshCredential } from "../auth-profiles/credential-fixtures.test-support.js";
import { closeAuthProfileReadPool } from "../auth-profiles/sqlite.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import { resolveOwnerPromptNumbers } from "../owner-display.js";
import { buildAgentSystemPrompt } from "../system-prompt.js";
import { createCompletionHandoff } from "./attempt-execution.announce.test-support.js";
import {
  cliRuntimeConfig,
  makeRunAgentAttemptParams,
  makeSessionEntry,
  saveTestAuthProfiles,
  type RunAgentAttemptOverrides,
} from "./attempt-execution.cli.test-support.js";
import { runAgentAttempt as runAgentAttemptImpl } from "./attempt-execution.js";

const runCliAgentMock = vi.hoisted(() => vi.fn());
const runEmbeddedAgentMock = vi.hoisted(() => vi.fn());
// mock-isolation: Observe CLI admission without launching an external process.
vi.mock("../cli-runner.js", () => ({ runCliAgent: runCliAgentMock }));
// mock-isolation: Capture forwarded harness parameters without starting model execution.
vi.mock("../embedded-agent.js", () => ({ runEmbeddedAgent: runEmbeddedAgentMock }));

const runAgentAttempt = (params: RunAgentAttemptOverrides) => {
  const prepared = makeRunAgentAttemptParams(params);
  setRuntimeConfigSnapshot(prepared.cfg);
  return runAgentAttemptImpl(prepared);
};
function expectMockArgFields(
  mock: ReturnType<typeof vi.fn>,
  fields: Record<string, unknown>,
  index = 0,
) {
  expect(mock.mock.calls[index]?.[0]).toEqual(expect.objectContaining(fields));
}

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
  const { createCliRuntimeExecutionProviderMock } =
    await import("./attempt-execution.model-runtime.test-support.js");
  return {
    ...actual,
    resolveCliRuntimeExecutionProvider: createCliRuntimeExecutionProviderMock(),
  };
});

describe("embedded attempt harness pinning", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-embedded-attempt-"));
    runCliAgentMock.mockReset();
    runEmbeddedAgentMock
      .mockReset()
      .mockResolvedValueOnce({ meta: { durationMs: 1 } } satisfies EmbeddedAgentRunResult);
  });

  afterEach(async () => {
    closeAuthProfileReadPool({ kind: "root", rootPath: tmpDir });
    await cleanupSessionStateForTest({ stateDir: tmpDir });
    await fs.rm(tmpDir, { recursive: true, force: true });
    clearRuntimeConfigSnapshot();
  });

  function runHarnessAttempt(
    overrides: Omit<RunAgentAttemptOverrides, "agentDir" | "sessionKey" | "workspaceDir">,
    sessionKey = "agent:main:main",
  ) {
    return runAgentAttempt({
      sessionKey,
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      sessionHasHistory: true,
      ...overrides,
    });
  }

  it("renders the user turn's configured owners on a subagent completion turn", async () => {
    const cfg: OpenClawConfig = {
      commands: { ownerAllowFrom: ["telegram:111", "discord:222", "333"] },
    };
    const userTurn = await resolveCommandAuthorizationAsync({
      ctx: { Provider: "telegram", Surface: "telegram", From: "telegram:111", SenderId: "111" },
      cfg,
      commandAuthorized: true,
    });
    const sessionKey = "agent:main:telegram:direct:111";
    const sessionEntry = makeSessionEntry("owner-session");
    await runHarnessAttempt(
      {
        cfg,
        sessionEntry,
        messageChannel: "telegram",
        opts: createCompletionHandoff({
          targetSessionKey: sessionKey,
          targetSessionId: sessionEntry.sessionId,
          sourceSessionKey: "agent:main:subagent:owner-child",
          sourceSessionId: "owner-child-session",
          provider: "openai",
          model: "gpt-5.4",
        }),
      },
      sessionKey,
    );
    const completion = runEmbeddedAgentMock.mock.calls[0]?.[0];
    const prompt = (ownerNumbers?: string[]) =>
      buildAgentSystemPrompt({ workspaceDir: "/workspace", ownerNumbers });

    expect(prompt(completion?.ownerNumbers)).toBe(
      prompt(resolveOwnerPromptNumbers({ ownerNumbers: userTurn.ownerList, ...userTurn })),
    );
    expect(prompt(completion?.ownerNumbers)).toContain("Allowlisted senders: 111, 333.");
    expect(completion?.senderIsOwner).not.toBe(true);
  });

  it.each(["saved", "run-scoped"] as const)(
    "rejects a %s Access override before starting an unsupported CLI runtime",
    async (source) => {
      const sessionKey = "agent:main:access-cli";
      const sessionEntry = makeSessionEntry(
        "access-cli",
        source === "saved" ? { cyberAccessProgram: "standard" } : {},
      );
      const storePath = path.join(tmpDir, "sessions.json");
      await replaceSessionEntry({ sessionKey, storePath }, sessionEntry);
      await expect(
        runHarnessAttempt(
          {
            providerOverride: "claude-cli",
            modelOverride: "opus",
            sessionEntry,
            storePath,
            ...(source === "run-scoped" ? { cyberAccessProgram: "daybreak_blue" as const } : {}),
          },
          sessionKey,
        ),
      ).rejects.toThrow("Explicit access programs are unsupported by this CLI runtime");
      expect(runCliAgentMock).not.toHaveBeenCalled();
    },
  );

  it.each(["openclaw", "codex"] as const)(
    "forwards persisted Access choices to %s command turns",
    async (runtime) => {
      for (const program of ["standard", "daybreak_blue"] as const) {
        const sessionEntry = makeSessionEntry("access-" + runtime + "-" + program, {
          cyberAccessProgram: program,
        });
        runEmbeddedAgentMock.mockResolvedValueOnce({
          meta: { durationMs: 1 },
        } satisfies EmbeddedAgentRunResult);
        await runHarnessAttempt({
          providerOverride: "openai",
          modelOverride: "gpt-6.1-sol",
          sessionEntry,
          agentHarnessRuntimeOverride: runtime,
          opts: { extraSystemPromptTurnContext: { start: 0, text: "Current turn context" } },
        });
        expectMockArgFields(
          runEmbeddedAgentMock,
          {
            cyberAccessProgram: program,
            extraSystemPromptTurnContext: { start: 0, text: "Current turn context" },
          },
          runEmbeddedAgentMock.mock.calls.length - 1,
        );
      }
    },
  );

  it("keeps a catalog-adopted Codex harness pinned for direct command attempts", async () => {
    const sessionEntry = makeSessionEntry("mixed-provider-session", {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      pluginExtensions: {
        codex: {
          supervision: {
            sourceThreadId: "019f-codex-thread",
            modelLocked: true,
          },
        },
      },
    });
    await runHarnessAttempt({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-7",
      cfg: cliRuntimeConfig("anthropic/claude-opus-4-7", "claude-cli"),
      sessionEntry,
      agentHarnessRuntimeOverride: "codex",
      body: "switch to minimax",
      opts: { toolsAllow: ["read", "web_search"], codeModeOverride: false },
      runId: "run-mixed-provider-auto-runtime",
    });

    expect(runCliAgentMock).not.toHaveBeenCalled();
    expectMockArgFields(runEmbeddedAgentMock, {
      provider: "anthropic",
      model: "claude-opus-4-7",
      agentHarnessId: "codex",
      agentHarnessRuntimeOverride: "codex",
      modelSelectionLocked: true,
      toolsAllow: ["read", "web_search"],
      codeModeOverride: false,
    });
  });

  it("auto-forwards OpenAI Codex auth profiles to default Codex harness runs", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const sessionEntry = makeSessionEntry("codex-auth-session");
    saveTestAuthProfiles(tmpDir, {
      "openai:work": createOAuthRefreshCredential(),
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: vi.fn(),
    });

    try {
      await runHarnessAttempt({
        sessionEntry,
        runId: "run-codex-auto-auth-profile",
      });
    } finally {
      clearAgentHarnesses();
    }

    expectMockArgFields(runEmbeddedAgentMock, {
      agentHarnessId: undefined,
      authProfileId: "openai:work",
      authProfileIdSource: "auto",
    });
  });

  it("honors a runtime request without promoting observations to a pin (owner model-owner)", async () => {
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
    await runHarnessAttempt({
      modelOverride: "gpt-5.6-sol",
      modelThinkingCapability,
      sessionEntry,
      agentHarnessRuntimeOverride: "openclaw",
      resolvedThinkLevel: "max",
      runId: "run-explicit-openclaw-runtime",
    });

    expectMockArgFields(runEmbeddedAgentMock, {
      provider: "openai",
      model: "gpt-5.6-sol",
      modelThinkingCapability,
      agentHarnessId: undefined,
      agentHarnessRuntimeOverride: "openclaw",
      thinkLevel: "max",
    });
  });
});
