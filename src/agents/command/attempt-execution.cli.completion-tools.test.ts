import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  McpLoopbackToolCache,
  resolveMcpLoopbackScopedTools,
} from "../../gateway/mcp-http.runtime.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../auth-profiles/runtime-snapshots.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import { buildCliMcpGrantContext } from "../cli-runner/mcp-grant-context.js";
import type { RunCliAgentParams } from "../cli-runner/types.js";
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

vi.mock("../cli-runner.js", () => ({ runCliAgent: runCliAgentMock }));
vi.mock("../embedded-agent.js", () => ({ runEmbeddedAgent: runEmbeddedAgentMock }));
vi.mock("../cli-runner/cli-live-session-registry.js", () => ({
  getCliLiveSessionGeneration: vi.fn(() => undefined),
  hasCliLiveSession: vi.fn(() => false),
}));
vi.mock("../model-selection.js", async () => ({
  ...(await vi.importActual<typeof import("../model-selection.js")>("../model-selection.js")),
  isCliProvider: (provider: string) =>
    ["claude-cli", "codex-cli", "google-gemini-cli"].includes(provider.trim().toLowerCase()),
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));
vi.mock("../model-runtime-aliases.js", async () => ({
  ...(await vi.importActual<typeof import("../model-runtime-aliases.js")>(
    "../model-runtime-aliases.js",
  )),
  resolveCliRuntimeExecutionProvider: ({ provider }: { provider?: string }) => provider,
}));

type TrustedHandoff = NonNullable<RunCliAgentParams["trustedInternalHandoff"]>;

const runAgentAttempt = (params: RunAgentAttemptOverrides) =>
  runAgentAttemptImpl(makeRunAgentAttemptParams(params));

function expectMockArgFields(fields: Record<string, unknown>) {
  const arg = runCliAgentMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(fields)) {
    expect(arg?.[key]).toEqual(value);
  }
}

describe("CLI completion tool handoffs", () => {
  const fixtureRoot = createSuiteTempRootTracker({ prefix: "openclaw-cli-completion-tools-" });
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
        {
          id: "google-gemini-cli",
          modelProvider: "google",
          pluginId: "google",
          config: { command: "gemini" },
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

  it.each([
    { name: "a non-Claude CLI runtime", providerName: "google-gemini-cli", execHost: undefined },
    { name: "a node-hosted Claude CLI requester", providerName: "claude-cli", execHost: "node" },
  ] as const)(
    "keeps trusted completion handoffs off the requester tools for $name",
    async ({ providerName, execHost }) => {
      const sessionKey = "agent:main:direct:cli-announce-unenforced";
      const sessionEntry = makeSessionEntry(
        "openclaw-session-cli-announce-unenforced",
        execHost ? { execHost } : {},
      );
      const sessionStore = createSubagentAnnounceSessionStore(sessionKey, sessionEntry, {});
      await writeSessionStoreSeed(sessionStore);
      runCliAgentMock.mockResolvedValue(makeCliResult("completion announce"));

      for (const sourceReplyDeliveryMode of ["automatic", "message_tool_only"] as const) {
        runCliAgentMock.mockClear();
        await runStoredAttempt({
          providerOverride: providerName,
          modelOverride: "opus",
          cfg: { session: { store: storePath } },
          sessionEntry,
          sessionKey,
          body: "A background task finished. Process the completion update now.",
          runId: `run-cli-announce-unenforced-${sourceReplyDeliveryMode}`,
          opts: createSubagentAnnounceHandoffOptions({
            sourceReplyDeliveryMode,
            targetSessionKey: sessionKey,
            targetSessionId: sessionEntry.sessionId,
            provider: providerName,
            model: "opus",
          }),
          messageChannel: "telegram",
          sessionStore,
        });

        expectMockArgFields({
          provider: providerName,
          ...(sourceReplyDeliveryMode === "automatic"
            ? { disableTools: true, toolsAllow: undefined }
            : { disableTools: false, toolsAllow: ["message"] }),
          trustedInternalHandoff: undefined,
        });
      }
    },
  );

  it.each([
    { name: "a missing capability", seedChildLineage: true, forge: () => undefined },
    {
      name: "a capability minted for another requester session",
      seedChildLineage: true,
      forge: (handoff: TrustedHandoff) => ({ ...handoff, targetSessionId: "another-session" }),
    },
    {
      name: "a capability minted for another model",
      seedChildLineage: true,
      forge: (handoff: TrustedHandoff) => ({ ...handoff, model: "sonnet" }),
    },
    {
      name: "a capability without persisted child lineage",
      seedChildLineage: false,
      forge: (handoff: TrustedHandoff) => handoff,
    },
  ])(
    "keeps a Claude CLI completion handoff tool-free for $name",
    async ({ seedChildLineage, forge }) => {
      const sessionKey = "agent:main:direct:claude-announce-unverified";
      const sessionEntry = makeSessionEntry("openclaw-session-cli-announce-unverified");
      const sessionStore = seedChildLineage
        ? createSubagentAnnounceSessionStore(sessionKey, sessionEntry, {})
        : { [sessionKey]: sessionEntry };
      await writeSessionStoreSeed(sessionStore);
      runCliAgentMock.mockResolvedValue(makeCliResult("completion announce"));

      for (const sourceReplyDeliveryMode of ["automatic", "message_tool_only"] as const) {
        runCliAgentMock.mockClear();
        const opts = createSubagentAnnounceHandoffOptions({
          sourceReplyDeliveryMode,
          targetSessionKey: sessionKey,
          targetSessionId: sessionEntry.sessionId,
          provider: "claude-cli",
          model: "opus",
        });
        const { trustedInternalHandoff, ...unverifiedOpts } = opts;
        const forged = trustedInternalHandoff ? forge(trustedInternalHandoff) : undefined;
        await runStoredAttempt({
          providerOverride: "claude-cli",
          modelOverride: "opus",
          cfg: { session: { store: storePath } },
          sessionEntry,
          sessionKey,
          body: "A background task finished. Process the completion update now.",
          runId: `run-cli-announce-unverified-${sourceReplyDeliveryMode}`,
          opts: { ...unverifiedOpts, ...(forged ? { trustedInternalHandoff: forged } : {}) },
          messageChannel: "telegram",
          sessionStore,
        });

        expectMockArgFields({
          provider: "claude-cli",
          disableTools: true,
          toolsAllow: undefined,
          trustedInternalHandoff: undefined,
        });
      }
    },
  );

  const trustedSessionKey = "agent:main:direct:claude-trusted-announce";
  const trustedChildSessionKey = "agent:openclaw:subagent:child";
  const trustedChildEntry: SessionEntry = {
    sessionId: "child-session-id",
    updatedAt: 1,
    spawnedBy: trustedSessionKey,
    spawnDepth: 1,
    subagentRole: "orchestrator",
    subagentControlScope: "children",
    inheritedToolPolicyVersion: 1,
    inheritedToolDeny: ["exec"],
  };

  /** Runs a verified Claude CLI completion and returns the grant its runner would mint. */
  async function runTrustedClaudeCompletion(child: Partial<SessionEntry> = {}) {
    const sessionEntry = makeSessionEntry("openclaw-session-cli-trusted-announce");
    const sessionStore: Record<string, SessionEntry> = {
      [trustedSessionKey]: sessionEntry,
      [trustedChildSessionKey]: { ...trustedChildEntry, ...child },
    };
    await writeSessionStoreSeed(sessionStore);
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("trusted announce"));

    await runStoredAttempt({
      providerOverride: "claude-cli",
      modelOverride: "opus",
      cfg: { session: { store: storePath } } as OpenClawConfig,
      sessionEntry,
      sessionKey: trustedSessionKey,
      body: "A background task finished. Process the completion update now.",
      runId: "run-cli-trusted-announce",
      opts: {
        trustedInternalHandoff: {
          kind: "subagent-completion",
          sourceSessionKey: trustedChildSessionKey,
          sourceSessionId: trustedChildEntry.sessionId,
          targetSessionKey: trustedSessionKey,
          targetSessionId: sessionEntry.sessionId,
          provider: "claude-cli",
          model: "opus",
        },
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: trustedChildSessionKey,
          sourceChannel: "internal",
          sourceTool: "subagent_announce",
        },
        internalEvents: [
          {
            type: "task_completion",
            source: "subagent",
            childSessionKey: trustedChildSessionKey,
            childSessionId: trustedChildEntry.sessionId,
            announceType: "subagent task",
            taskLabel: "review",
            status: "ok",
            statusLabel: "completed",
            result: "child output",
            replyInstruction: "Relay this completion.",
          },
        ],
      },
      messageChannel: "telegram",
      sessionStore,
    });

    expectMockArgFields({
      provider: "claude-cli",
      disableTools: false,
      terminalReplyExpectation: "required",
    });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    const run = runCliAgentMock.mock.calls[0]?.[0] as RunCliAgentParams;
    expect(run.trustedInternalHandoff?.sourceSessionKey).toBe(trustedChildSessionKey);
    return buildCliMcpGrantContext({
      run,
      config: { session: { store: storePath } },
      requireExplicitMessageTarget: false,
      agentId: "main",
      modelProvider: "claude-cli",
      modelId: "opus",
      toolsAllow: ["read", "exec"],
    });
  }

  it("preserves inherited denies in the trusted Claude CLI completion MCP surface", async () => {
    const context = await runTrustedClaudeCompletion();

    const scoped = await resolveMcpLoopbackScopedTools({
      cfg: { session: { store: storePath } },
      context,
    });

    expect(scoped.tools.map((tool) => tool.name)).toEqual(["read"]);
  });

  it("fails closed when a completion grant outlives its requester lineage", async () => {
    const context = await runTrustedClaudeCompletion();
    await replaceSessionEntry(
      { sessionKey: trustedChildSessionKey, storePath },
      { ...trustedChildEntry, spawnedBy: "agent:main:direct:another-requester" },
    );
    clearSessionStoreCacheForTest();

    await expect(
      resolveMcpLoopbackScopedTools({ cfg: { session: { store: storePath } }, context }),
    ).rejects.toThrow("CLI completion tool grant no longer matches its requester policy");
  });

  it("rechecks requester lineage before serving cached completion tools", async () => {
    const context = await runTrustedClaudeCompletion();
    const cfg = { session: { store: storePath } };
    const cache = new McpLoopbackToolCache();
    const first = await cache.resolve({ cfg, context, grantToken: "completion-grant" });
    expect(first.tools.map((tool) => tool.name)).toEqual(["read"]);

    await replaceSessionEntry(
      { sessionKey: trustedChildSessionKey, storePath },
      { ...trustedChildEntry, spawnedBy: "agent:main:direct:another-requester" },
    );
    clearSessionStoreCacheForTest();

    // The second request would be a cache hit; the lineage check must still run.
    await expect(cache.resolve({ cfg, context, grantToken: "completion-grant" })).rejects.toThrow(
      "CLI completion tool grant no longer matches its requester policy",
    );
  });

  it("rechecks requester lineage when it changes while a cached lookup awaits", async () => {
    const context = await runTrustedClaudeCompletion();
    const cfg = { session: { store: storePath } };
    const cache = new McpLoopbackToolCache();
    await cache.resolve({ cfg, context, grantToken: "completion-grant" });

    // The lookup yields before it reads the cache; the child is re-parented in that window.
    const pending = cache.resolve({ cfg, context, grantToken: "completion-grant" });
    replaceSessionEntrySync(
      { sessionKey: trustedChildSessionKey, storePath },
      { ...trustedChildEntry, spawnedBy: "agent:main:direct:another-requester" },
    );
    clearSessionStoreCacheForTest();

    await expect(pending).rejects.toThrow(
      "CLI completion tool grant no longer matches its requester policy",
    );
  });
});
