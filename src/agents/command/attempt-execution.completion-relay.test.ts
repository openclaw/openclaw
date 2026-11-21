import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../auth-profiles/runtime-snapshots.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import type { RunCliAgentParams } from "../cli-runner/types.js";
import { resetGeneratedMediaTaskActivityForTests } from "../media-generation-activity.test-support.js";
import {
  SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION,
  SUBAGENT_COMPLETION_RELAY_ONLY_INSTRUCTION,
} from "../subagents/completion/subagent-completion-instructions.js";
import {
  createSubagentAnnounceHandoffOptions,
  createSubagentAnnounceSessionStore,
} from "./attempt-execution.announce.test-support.js";
import {
  makeCliResult,
  makeRunAgentAttemptParams,
  makeSessionEntry,
  resetCliAttemptFixtureDatabases,
  type RunAgentAttemptOverrides,
} from "./attempt-execution.cli.test-support.js";
import { runAgentAttempt as runAgentAttemptImpl } from "./attempt-execution.js";

const runCliAgentMock = vi.hoisted(() => vi.fn());
const runEmbeddedAgentMock = vi.hoisted(() => vi.fn());
const hasClaudeSessionMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("../cli-runner/log.js", () => ({
  cliBackendLog: { warn: vi.fn() },
}));
// mock-isolation: observe the CLI attempt surface without launching a process.
vi.mock("../cli-runner.js", () => ({
  runCliAgent: runCliAgentMock,
}));
vi.mock("../cli-runner/cli-live-session-registry.js", () => ({
  getCliLiveSessionGeneration: vi.fn(() => undefined),
  hasCliLiveSession: hasClaudeSessionMock,
}));
// mock-isolation: capture embedded attempt params without starting model execution.
vi.mock("../embedded-agent.js", () => ({
  runEmbeddedAgent: runEmbeddedAgentMock,
}));
vi.mock("../model-selection.js", async () => ({
  ...(await vi.importActual<typeof import("../model-selection.js")>("../model-selection.js")),
  isCliProvider: (provider: string, _cfg?: OpenClawConfig) => {
    const normalized = provider.trim().toLowerCase();
    return ["claude-cli", "codex-cli", "google-gemini-cli"].includes(normalized);
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

const runAgentAttempt = (params: RunAgentAttemptOverrides) => {
  const prepared = makeRunAgentAttemptParams(params);
  setRuntimeConfigSnapshot(prepared.cfg);
  return runAgentAttemptImpl(prepared);
};

const ANNOUNCE_INSTRUCTION = `A completed subagent task is ready for parent review. ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION}`;

describe("completion relay guidance matches the resolved tool surface", () => {
  const fixtureRoot = createSuiteTempRootTracker({ prefix: "openclaw-completion-relay-suite-" });
  let suiteRoot: string;
  let agentDir: string;
  let tmpDir: string;
  let storePath: string;
  let homeEnvSnapshot: ReturnType<typeof captureEnv> | undefined;

  beforeAll(async () => {
    suiteRoot = await fixtureRoot.setup();
    agentDir = path.join(suiteRoot, "agents", "main", "agent");
    storePath = path.join(suiteRoot, "sessions.json");
    await fs.mkdir(agentDir, { recursive: true });
  });

  beforeEach(async () => {
    homeEnvSnapshot = captureEnv(["HOME", "OPENCLAW_STATE_DIR", "CLAUDE_CONFIG_DIR"]);
    deleteTestEnvValue("CLAUDE_CONFIG_DIR");
    setTestEnvValue("OPENCLAW_STATE_DIR", suiteRoot);
    setRuntimeConfigSnapshot({ session: { store: storePath } });
    tmpDir = await fixtureRoot.make();
    runCliAgentMock.mockReset();
    runEmbeddedAgentMock.mockReset();
    resetGeneratedMediaTaskActivityForTests();
    hasClaudeSessionMock.mockReset();
    hasClaudeSessionMock.mockReturnValue(false);
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolvePluginSetupRegistry: () => ({ cliBackends: [] }) as never,
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude", forkArg: "--fork-session" },
        },
      ],
    });
  });

  afterEach(async () => {
    cliBackendsTesting.resetDepsForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    clearSessionStoreCacheForTest();
    resetCliAttemptFixtureDatabases(suiteRoot);
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(storePath, { force: true });
    clearRuntimeConfigSnapshot();
    homeEnvSnapshot?.restore();
    homeEnvSnapshot = undefined;
  });

  afterAll(async () => {
    await cleanupSessionStateForTest({ stateDir: suiteRoot });
    await fixtureRoot.cleanup();
  });

  async function writeSessionStoreSeed(sessionStore: Record<string, SessionEntry>): Promise<void> {
    for (const [sessionKey, entry] of Object.entries(sessionStore)) {
      await replaceSessionEntry({ sessionKey, storePath }, entry);
    }
  }

  function runStoredAttempt(
    overrides: Omit<RunAgentAttemptOverrides, "agentDir" | "storePath" | "workspaceDir">,
  ) {
    return runAgentAttempt({ workspaceDir: tmpDir, agentDir, storePath, ...overrides });
  }

  async function runAnnounceAttempt(params: {
    sessionKey: string;
    runId: string;
    stripTrustedHandoff: boolean;
  }): Promise<RunCliAgentParams> {
    const sessionEntry = makeSessionEntry(`openclaw-session-${params.runId}`);
    const sessionStore = createSubagentAnnounceSessionStore(params.sessionKey, sessionEntry, {});
    await writeSessionStoreSeed(sessionStore);
    runCliAgentMock.mockResolvedValue(makeCliResult("completion announce"));

    const opts = createSubagentAnnounceHandoffOptions({
      sourceReplyDeliveryMode: "automatic",
      targetSessionKey: params.sessionKey,
      targetSessionId: sessionEntry.sessionId,
      provider: "claude-cli",
      model: "opus",
    });
    if (params.stripTrustedHandoff) {
      // Simulate the degraded path: the in-process envelope did not survive
      // (restart recovery / unverified handoff), so no tools may be retained.
      delete opts.trustedInternalHandoff;
    }
    for (const event of opts.internalEvents ?? []) {
      event.replyInstruction = ANNOUNCE_INSTRUCTION;
    }

    await runStoredAttempt({
      providerOverride: "claude-cli",
      modelOverride: "opus",
      cfg: { session: { store: storePath } },
      sessionEntry,
      sessionKey: params.sessionKey,
      body: ANNOUNCE_INSTRUCTION,
      runId: params.runId,
      opts,
      messageChannel: "telegram",
      sessionStore,
    });

    return runCliAgentMock.mock.calls[0]?.[0] as RunCliAgentParams;
  }

  it("rewrites completion guidance to relay-only on a restricted relay turn", async () => {
    const run = await runAnnounceAttempt({
      sessionKey: "agent:main:direct:relay-only-announce",
      runId: "run-relay-only-announce",
      stripTrustedHandoff: true,
    });

    // The turn is tool-free, so the continuation clause must not survive in the
    // prompt or in the runtime-context fragments; relay-only guidance that keeps
    // the child outcome and records follow-up needs must replace it.
    expect(run.disableTools).toBe(true);
    expect(run.prompt).toContain(SUBAGENT_COMPLETION_RELAY_ONLY_INSTRUCTION);
    expect(run.prompt).not.toContain(SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION);
    const fragmentTexts = (run.runtimeContextFragments ?? []).map((fragment) => fragment.text);
    expect(
      fragmentTexts.some((text) => text.includes(SUBAGENT_COMPLETION_RELAY_ONLY_INSTRUCTION)),
    ).toBe(true);
    expect(
      fragmentTexts.some((text) => text.includes(SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION)),
    ).toBe(false);
  });

  it("keeps continuation guidance on a trusted completion handoff turn", async () => {
    const run = await runAnnounceAttempt({
      sessionKey: "agent:main:direct:trusted-announce",
      runId: "run-trusted-announce",
      stripTrustedHandoff: false,
    });

    // A verified in-process handoff retains the requester tool surface, so the
    // continuation guidance is still correct and must stay untouched.
    expect(run.disableTools).toBe(false);
    expect(run.prompt).toContain(SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION);
    expect(run.prompt).not.toContain(SUBAGENT_COMPLETION_RELAY_ONLY_INSTRUCTION);
  });
});
