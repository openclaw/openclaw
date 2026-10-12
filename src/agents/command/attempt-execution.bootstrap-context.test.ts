// Covers bootstrap-context forwarding through the shared attempt parameters used
// by both CLI and embedded execution (issue #169704). Extracted as a sibling
// module: the CLI attempt suite is grandfathered over the max-lines cap.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import {
  makeCliResult,
  makeRunAgentAttemptParams,
  makeSessionEntry,
  resetCliAttemptFixtureDatabases,
  type RunAgentAttemptOverrides,
} from "./attempt-execution.cli.test-support.js";
import { runAgentAttempt as runAgentAttemptImpl } from "./attempt-execution.js";

const runAgentAttempt = (params: RunAgentAttemptOverrides) =>
  runAgentAttemptImpl(makeRunAgentAttemptParams(params));

const runCliAgentMock = vi.hoisted(() => vi.fn());
const runEmbeddedAgentMock = vi.hoisted(() => vi.fn());

vi.mock("../cli-runner.js", () => ({
  runCliAgent: runCliAgentMock,
}));

vi.mock("../cli-runner/cli-live-session-registry.js", () => ({
  getCliLiveSessionGeneration: vi.fn(() => undefined),
  hasCliLiveSession: vi.fn(() => false),
}));

vi.mock("../embedded-agent.js", () => ({
  runEmbeddedAgent: runEmbeddedAgentMock,
}));

vi.mock("../model-selection.js", async () => ({
  ...(await vi.importActual<typeof import("../model-selection.js")>("../model-selection.js")),
  isCliProvider: (provider: string) => {
    const normalized = provider.trim().toLowerCase();
    return (
      normalized === "claude-cli" ||
      normalized === "codex-cli" ||
      normalized === "google-gemini-cli"
    );
  },
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

describe("attempt execution bootstrap context forwarding", () => {
  const fixtureRoot = createSuiteTempRootTracker({ prefix: "openclaw-cli-bootstrap-suite-" });
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
    homeEnvSnapshot = captureEnv(["HOME", "OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", suiteRoot);
    tmpDir = await fixtureRoot.make();
    runCliAgentMock.mockReset();
    runEmbeddedAgentMock.mockReset();
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
    clearSessionStoreCacheForTest();
    resetCliAttemptFixtureDatabases(suiteRoot);
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(storePath, { force: true });
    homeEnvSnapshot?.restore();
    homeEnvSnapshot = undefined;
  });

  afterAll(async () => {
    await cleanupSessionStateForTest({ stateDir: suiteRoot });
    await fixtureRoot.cleanup();
  });

  async function seedSessionStore(sessionKey: string, sessionEntry: SessionEntry) {
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    for (const [key, entry] of Object.entries(sessionStore)) {
      await replaceSessionEntry({ sessionKey: key, storePath }, entry);
    }
    return sessionStore;
  }

  function runStoredAttempt(
    overrides: Omit<RunAgentAttemptOverrides, "agentDir" | "storePath" | "workspaceDir">,
  ) {
    return runAgentAttempt({ workspaceDir: tmpDir, agentDir, storePath, ...overrides });
  }

  it("forwards the lightContext bootstrap mode to CLI execution", async () => {
    const sessionKey = "agent:main:cli-light-context";
    const sessionEntry = makeSessionEntry("session-cli-light-context");
    const sessionStore = await seedSessionStore(sessionKey, sessionEntry);
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("light"));

    await runStoredAttempt({
      providerOverride: "claude-cli",
      modelOverride: "opus",
      sessionKey,
      sessionEntry,
      sessionStore,
      body: "Reply with exactly OK",
      runId: "cli-light-context",
      opts: {
        bootstrapContextMode: "lightweight",
        bootstrapContextRunKind: "default",
      },
    });

    expect(runCliAgentMock.mock.calls[0]?.[0]).toMatchObject({
      bootstrapContextMode: "lightweight",
      bootstrapContextRunKind: "default",
    });
  });

  it("keeps forwarding the lightContext bootstrap mode to embedded execution", async () => {
    const sessionKey = "agent:main:embedded-light-context";
    const sessionEntry = makeSessionEntry("session-embedded-light-context");
    const sessionStore = await seedSessionStore(sessionKey, sessionEntry);
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runStoredAttempt({
      originalProvider: "openai",
      sessionKey,
      sessionEntry,
      sessionStore,
      body: "Reply with exactly OK",
      runId: "embedded-light-context",
      opts: {
        bootstrapContextMode: "lightweight",
        bootstrapContextRunKind: "default",
      },
    });

    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
      bootstrapContextMode: "lightweight",
      bootstrapContextRunKind: "default",
    });
  });
});
