import path from "node:path";
import { expect, vi, type Mock } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { listOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.test-support.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createTestPreparedRunAdmission } from "../admitted-run-context.test-support.js";
import { createAuthProfileStoreFixture } from "../auth-profiles/credential-fixtures.test-support.js";
import { saveAuthProfileStore } from "../auth-profiles/store-runtime.js";
import { buildCliMcpGrantContext } from "../cli-runner/mcp-grant-context.js";
import type { RunCliAgentParams } from "../cli-runner/types.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import type { ModelFallbackAttemptProvenance } from "../model-fallback.types.js";
import type { runAgentAttempt } from "./attempt-execution.js";

export function resetCliAttemptFixtureDatabases(suiteRoot: string): void {
  for (const database of listOpenClawAgentDatabasesForTest()) {
    if (!database.path.startsWith(`${suiteRoot}${path.sep}`)) {
      continue;
    }
    runOpenClawAgentWriteTransaction(
      (fixture) => {
        fixture.db.exec(`
          DELETE FROM session_transcript_fts;
          DELETE FROM session_transcript_fts_rows;
          DELETE FROM session_nodes;
          DELETE FROM conversations;
          DELETE FROM auth_profile_store;
          DELETE FROM auth_profile_state;
          DELETE FROM cache_entries;
        `);
      },
      database,
      { operationLabel: "test.attempt-execution.reset" },
    );
  }
}

/** Model capability and channel discovery fixtures for CLI fallback tests. */
export function createCliImageCapabilityPlugins(model: string) {
  // MCP still builds message schemas before applying the read-only grant.
  // Keep this capability test independent of bundled Discord action discovery.
  const pluginRegistry = createTestRegistry([
    {
      pluginId: "discord",
      source: "test",
      plugin: {
        ...createChannelTestPluginBase({ id: "discord" }),
        actions: { describeMessageTool: () => null },
      } satisfies ChannelPlugin,
    },
  ]);
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "anthropic",
        providers: ["anthropic"],
        cliBackends: ["claude-cli"],
        modelCatalog: {
          providers: {
            anthropic: {
              models: [{ id: model, name: model, reasoning: true, input: ["text", "image"] }],
            },
          },
        },
      },
    ],
  });
  return { metadataSnapshot, pluginRegistry };
}

export type RunAgentAttemptParams = Parameters<typeof runAgentAttempt>[0];
export type RunAgentAttemptOverrides = Omit<
  Partial<RunAgentAttemptParams>,
  | "agentDir"
  | "modelRoutingProvenance"
  | "opts"
  | "runContext"
  | "sessionEntry"
  | "sessionKey"
  | "workspaceDir"
> & {
  agentDir: RunAgentAttemptParams["agentDir"];
  modelRoutingProvenance?: ModelFallbackAttemptProvenance;
  sessionEntry: NonNullable<RunAgentAttemptParams["sessionEntry"]>;
  sessionKey: NonNullable<RunAgentAttemptParams["sessionKey"]>;
  workspaceDir: RunAgentAttemptParams["workspaceDir"];
  opts?: Partial<RunAgentAttemptParams["opts"]>;
  runContext?: Partial<RunAgentAttemptParams["runContext"]>;
};

export function makeRunAgentAttemptParams(
  overrides: RunAgentAttemptOverrides,
): RunAgentAttemptParams {
  const provider = overrides.providerOverride ?? "openai";
  const model = overrides.modelOverride ?? "gpt-5.4";
  const isFallbackRetry = overrides.isFallbackRetry ?? false;
  const runId = overrides.runId ?? `run-${overrides.sessionEntry.sessionId}`;
  const modelRoutingProvenance: ModelFallbackAttemptProvenance =
    overrides.modelRoutingProvenance ?? {
      requestedProvider: overrides.originalProvider ?? provider,
      requestedModel: model,
      stage: isFallbackRetry ? "fallback" : "initial",
    };
  return {
    providerOverride: provider,
    originalProvider: provider,
    modelOverride: model,
    cfg: {} as OpenClawConfig,
    sessionId: overrides.sessionEntry.sessionId,
    sessionAgentId: "main",
    sessionFile: path.join(overrides.workspaceDir, "session.jsonl"),
    body: "continue",
    isFallbackRetry,
    resolvedThinkLevel: "medium",
    timeoutMs: 1_000,
    runId,
    spawnedBy: undefined,
    messageChannel: undefined,
    skillsSnapshot: undefined,
    resolvedVerboseLevel: undefined,
    onAgentEvent: vi.fn(),
    authProfileProvider: provider,
    sessionHasHistory: false,
    ...overrides,
    modelRoutingProvenance,
    pluginGeneration: overrides.pluginGeneration,
    preparedRunAdmission: overrides.preparedRunAdmission ?? createTestPreparedRunAdmission(runId),
    lifecycleGeneration: overrides.lifecycleGeneration ?? getAgentEventLifecycleGeneration(),
    opts: { ...overrides.opts } as RunAgentAttemptParams["opts"],
    runContext: { ...overrides.runContext } as RunAgentAttemptParams["runContext"],
  };
}

export function makeCliResult(text: string, sessionId = "session-cli"): EmbeddedAgentRunResult {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 5,
      finalAssistantVisibleText: text,
      agentMeta: {
        sessionId,
        ...(sessionId ? { cliSessionBinding: { sessionId } } : {}),
        provider: "claude-cli",
        model: "opus",
        usage: {
          input: 12,
          output: 4,
          cacheRead: 3,
          cacheWrite: 0,
          total: 19,
        },
        lastCallUsage: {
          input: 12,
          output: 4,
          cacheRead: 3,
          cacheWrite: 0,
          total: 19,
        },
      },
      executionTrace: {
        winnerProvider: "claude-cli",
        winnerModel: "opus",
        fallbackUsed: false,
        runner: "cli",
      },
    },
  };
}

export function cliRuntimeConfig(modelRef: string, runtime: string): OpenClawConfig {
  return { agents: { defaults: { models: { [modelRef]: { agentRuntime: { id: runtime } } } } } };
}

export function saveTestAuthProfiles(
  agentDir: string,
  profiles: Parameters<typeof saveAuthProfileStore>[0]["profiles"],
) {
  saveAuthProfileStore(createAuthProfileStoreFixture(profiles), agentDir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
}

export function makeSessionEntry(
  sessionId: string,
  overrides: Partial<SessionEntry> = {},
): SessionEntry {
  return { sessionId, updatedAt: Date.now(), ...overrides };
}

export async function runTrustedClaudeCompletionForTest({
  storePath,
  writeSessionStoreSeed,
  runStoredAttempt,
  runCliAgentMock,
  runEmbeddedAgentMock,
}: {
  storePath: string;
  writeSessionStoreSeed: (entries: Record<string, SessionEntry>) => Promise<void>;
  runStoredAttempt: (
    params: Omit<RunAgentAttemptOverrides, "agentDir" | "storePath" | "workspaceDir">,
  ) => ReturnType<typeof runAgentAttempt>;
  runCliAgentMock: Mock;
  runEmbeddedAgentMock: Mock;
}) {
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

  const sessionEntry = makeSessionEntry("openclaw-session-cli-trusted-announce");
  const sessionStore: Record<string, SessionEntry> = {
    [trustedSessionKey]: sessionEntry,
    [trustedChildSessionKey]: trustedChildEntry,
  };
  await writeSessionStoreSeed(sessionStore);
  runCliAgentMock.mockResolvedValueOnce(makeCliResult("trusted announce"));

  await runStoredAttempt({
    providerOverride: "claude-cli",
    modelOverride: "opus",
    cfg: { session: { store: storePath } },
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
      runtimeContextFragments: [{ kind: "conversation-data", text: "supplemental context" }],
    },
    messageChannel: "telegram",
    sessionStore,
  });

  expect(runCliAgentMock.mock.calls[0]?.[0]).toMatchObject({
    provider: "claude-cli",
    disableTools: false,
    terminalReplyExpectation: "required",
  });
  expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  const run = runCliAgentMock.mock.calls[0]?.[0] as RunCliAgentParams;
  expect(run.runtimeContextFragments).toEqual([
    {
      kind: "runtime-instruction",
      text: "A background task completed. Keep internal details private and use its result to reply in your normal assistant voice.",
    },
    {
      kind: "conversation-data",
      text: expect.stringContaining("child output"),
    },
    {
      kind: "runtime-instruction",
      text: "Relay this completion.",
    },
    {
      kind: "conversation-data",
      text: "supplemental context",
    },
  ]);
  expect(run.trustedInternalHandoff?.sourceSessionKey).toBe(trustedChildSessionKey);
  const context = buildCliMcpGrantContext({
    run,
    config: { session: { store: storePath } },
    requireExplicitMessageTarget: false,
    agentId: "main",
    modelProvider: "claude-cli",
    modelId: "opus",
    toolsAllow: ["read", "exec"],
  });
  return { context, childSessionKey: trustedChildSessionKey, childEntry: trustedChildEntry };
}

export type EmbeddedAttemptFixtureOverrides = Omit<
  Partial<RunAgentAttemptOverrides>,
  "agentDir" | "workspaceDir" | "sessionEntry"
> & {
  config?: OpenClawConfig;
  sessionEntry?: Partial<SessionEntry>;
  additionalSessionEntries?: Record<string, Partial<SessionEntry>>;
};

export async function runOpenClawEmbeddedAttemptFixture({
  overrides,
  storePath,
  tmpDir,
  runStoredAttempt,
  writeSessionStoreSeed,
  runEmbeddedAgentMock,
}: {
  overrides: EmbeddedAttemptFixtureOverrides;
  storePath: string;
  tmpDir: string;
  runStoredAttempt: (
    overrides: Omit<RunAgentAttemptOverrides, "agentDir" | "storePath" | "workspaceDir">,
  ) => Promise<unknown>;
  writeSessionStoreSeed: (store: Record<string, SessionEntry>) => Promise<void>;
  runEmbeddedAgentMock: Mock;
}): Promise<void> {
  const {
    runId = "run-embedded-live-stream-gate",
    sessionKey = `agent:main:direct:${runId}`,
    sessionEntry: entry,
    additionalSessionEntries = {},
    config = { session: { store: storePath } },
    opts,
    ...attempt
  } = overrides;
  const sessionEntry = makeSessionEntry(`session-${runId}`, entry);
  const sessionStore = { [sessionKey]: sessionEntry };
  for (const [additionalSessionKey, additionalEntry] of Object.entries(additionalSessionEntries)) {
    sessionStore[additionalSessionKey] = makeSessionEntry(
      `${additionalSessionKey}-session`,
      additionalEntry,
    );
  }
  await writeSessionStoreSeed(sessionStore);
  runEmbeddedAgentMock.mockResolvedValueOnce({
    meta: { durationMs: 1 },
  } satisfies EmbeddedAgentRunResult);
  await runStoredAttempt({
    originalProvider: "openai",
    cfg: config,
    sessionEntry,
    sessionKey,
    sessionFile: path.join(tmpDir, `${runId}.jsonl`),
    body: "stream gate",
    runId,
    opts: {
      message: "stream gate",
      ...opts,
    },
    messageChannel: "telegram",
    sessionStore,
    ...attempt,
  });
}
