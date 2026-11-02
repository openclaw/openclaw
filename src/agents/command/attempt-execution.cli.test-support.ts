import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
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
import { createAgentAttemptLifecycleCallbacks } from "./attempt-callbacks.js";
import { createCompletionHandoff } from "./attempt-execution.announce.test-support.js";
import type { runAgentAttempt } from "./attempt-execution.js";

export function resetCliAttemptFixtureDatabases(suiteRoot: string): void {
  for (const database of listOpenClawAgentDatabasesForTest()) {
    if (!database.path.startsWith(`${suiteRoot}${path.sep}`)) {
      continue;
    }
    runOpenClawAgentWriteTransaction(
      (fixture) =>
        fixture.db.exec(`
          DELETE FROM session_transcript_fts;
          DELETE FROM session_transcript_fts_rows;
          DELETE FROM session_nodes;
          DELETE FROM conversations;
          DELETE FROM auth_profile_store;
          DELETE FROM auth_profile_state;
          DELETE FROM cache_entries;
        `),
      database,
      { operationLabel: "test.attempt-execution.reset" },
    );
  }
}

export function createCliImageCapabilityPlugins(model: string) {
  // MCP still builds message schemas before applying the read-only grant.
  // Keep this capability test independent of bundled Discord action discovery.
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({ id: "discord" }),
    actions: { describeMessageTool: () => null },
  };
  const pluginRegistry = createTestRegistry([{ pluginId: "discord", source: "test", plugin }]);
  const input: ("text" | "image")[] = ["text", "image"];
  const models = [{ id: model, name: model, reasoning: true, input }];
  const provider = {
    id: "anthropic",
    providers: ["anthropic"],
    cliBackends: ["claude-cli"],
    modelCatalog: { providers: { anthropic: { models } } },
  };
  const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [provider] });
  return { metadataSnapshot, pluginRegistry };
}

export type RunAgentAttemptParams = Parameters<typeof runAgentAttempt>[0];
export type RunAgentAttemptOverrides = Omit<
  Partial<RunAgentAttemptParams>,
  "opts" | "runContext"
> & {
  agentDir: RunAgentAttemptParams["agentDir"];
  sessionEntry: NonNullable<RunAgentAttemptParams["sessionEntry"]>;
  sessionKey: NonNullable<RunAgentAttemptParams["sessionKey"]>;
  workspaceDir: RunAgentAttemptParams["workspaceDir"];
  opts?: Partial<RunAgentAttemptParams["opts"]>;
  runContext?: Partial<RunAgentAttemptParams["runContext"]>;
};
type RunStoredAttempt = (
  params: Omit<RunAgentAttemptOverrides, "agentDir" | "storePath" | "workspaceDir">,
) => ReturnType<typeof runAgentAttempt>;

export function makeRunAgentAttemptParams(
  overrides: RunAgentAttemptOverrides,
): RunAgentAttemptParams {
  const provider = overrides.providerOverride ?? "openai";
  const model = overrides.modelOverride ?? "gpt-5.4";
  const isFallbackRetry = overrides.isFallbackRetry ?? false;
  const runId = overrides.runId ?? `run-${overrides.sessionEntry.sessionId}`;
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
    modelRoutingProvenance: overrides.modelRoutingProvenance ?? {
      requestedProvider: overrides.originalProvider ?? provider,
      requestedModel: model,
      stage: isFallbackRetry ? "fallback" : "initial",
    },
    pluginGeneration: overrides.pluginGeneration,
    preparedRunAdmission: overrides.preparedRunAdmission ?? createTestPreparedRunAdmission(runId),
    lifecycleGeneration: overrides.lifecycleGeneration ?? getAgentEventLifecycleGeneration(),
    opts: { ...overrides.opts } as RunAgentAttemptParams["opts"],
    runContext: { ...overrides.runContext } as RunAgentAttemptParams["runContext"],
  };
}

export function makeCliResult(text: string, sessionId = "session-cli"): EmbeddedAgentRunResult {
  const usage = { input: 12, output: 4, cacheRead: 3, cacheWrite: 0, total: 19 };
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
        usage: { ...usage },
        lastCallUsage: { ...usage },
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

export function makeSessionEntry(sessionId: string, overrides: Partial<SessionEntry> = {}) {
  return { sessionId, updatedAt: Date.now(), ...overrides };
}

export async function runTrustedClaudeCompletionForTest({
  storePath,
  writeSessionStoreSeed,
  runStoredAttempt,
  runCliAgentMock,
}: {
  storePath: string;
  writeSessionStoreSeed: (entries: Record<string, SessionEntry>) => Promise<void>;
  runStoredAttempt: RunStoredAttempt;
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
      ...createCompletionHandoff({
        sourceSessionKey: trustedChildSessionKey,
        sourceSessionId: trustedChildEntry.sessionId,
        targetSessionKey: trustedSessionKey,
        targetSessionId: sessionEntry.sessionId,
        provider: "claude-cli",
        model: "opus",
      }),
      runtimeContextFragments: [{ kind: "conversation-data", text: "supplemental context" }],
    },
    messageChannel: "telegram",
    sessionStore,
  });

  const run = runCliAgentMock.mock.calls[0]?.[0] as RunCliAgentParams;
  const fragment = (kind: string, text: unknown) => ({ kind, text });
  expect(run.runtimeContextFragments).toEqual([
    fragment(
      "runtime-instruction",
      "A background task completed. Keep internal details private and use its result to reply in your normal assistant voice.",
    ),
    fragment("conversation-data", expect.stringContaining("child output")),
    fragment("runtime-instruction", "Relay this completion."),
    fragment("conversation-data", "supplemental context"),
  ]);
  expect(run.trustedInternalHandoff?.sourceSessionKey).toBe(trustedChildSessionKey);
  const context = buildCliMcpGrantContext({
    run,
    config: { session: { store: storePath } },
    requireExplicitMessageTarget: false,
    agentId: "main",
    modelProvider: "claude-cli",
    modelId: "opus",
  });
  context.toolsAllow = ["read", "exec"];
  return { context, childSessionKey: trustedChildSessionKey, childEntry: trustedChildEntry };
}

export function registerCommandCliAdmissionTests({
  runStoredAttempt,
  seedSessionStore,
  runCliAgentMock,
  createCliSession,
  firstRunCliAgentArg,
}: {
  runStoredAttempt: RunStoredAttempt;
  seedSessionStore: (key: string, entry: SessionEntry) => Promise<Record<string, SessionEntry>>;
  runCliAgentMock: Mock<(params: RunCliAgentParams) => ReturnType<typeof runAgentAttempt>>;
  createCliSession: (
    key: string,
    entry: SessionEntry,
  ) => Promise<{
    runCli: (params: {
      onExecutionStarted?: () => void;
      onAgentEvent?: RunAgentAttemptParams["onAgentEvent"];
    }) => ReturnType<typeof runAgentAttempt>;
  }>;
  firstRunCliAgentArg: () => Record<string, unknown>;
}) {
  it("carries command-origin Git credit into a nonowner CLI grant", async () => {
    const sessionKey = "agent:main:main";
    const sessionEntry = makeSessionEntry("command-cli-git-credit");
    const sessionStore = await seedSessionStore(sessionKey, sessionEntry);
    runCliAgentMock.mockImplementationOnce(async (run: RunCliAgentParams) => {
      const context = buildCliMcpGrantContext({
        run,
        config: {},
        requireExplicitMessageTarget: false,
        agentId: "main",
        modelProvider: "anthropic",
        modelId: "opus",
      });
      expect(context.gitContributorProfileId).toBe("verified-command-requester");
      expect(context.senderIsOwner).toBe(false);
      return makeCliResult("Command completed");
    });

    await runStoredAttempt({
      providerOverride: "claude-cli",
      modelOverride: "opus",
      sessionEntry,
      sessionKey,
      sessionStore,
      opts: { gitContributorProfileId: "verified-command-requester", senderIsOwner: false },
    });
    expect(runCliAgentMock).toHaveBeenCalledOnce();
  });

  it("keeps CLI admission separate from observed assistant output", async () => {
    const { runCli } = await createCliSession(
      "agent:main:direct:cli-execution-started",
      makeSessionEntry("session-cli-execution-started"),
    );
    const onExecutionStarted = vi.fn();
    const onRuntimeTurnStarted = vi.fn();
    const callbacks = createAgentAttemptLifecycleCallbacks(
      { lifecycleFinishing: false, lifecycleEnded: false },
      onRuntimeTurnStarted,
    );
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("started"));
    await runCli({ onExecutionStarted, onAgentEvent: callbacks.onAgentEvent });
    expect(firstRunCliAgentArg().onExecutionStarted).toBe(onExecutionStarted);
    const observePhase = firstRunCliAgentArg().onExecutionPhase;
    if (typeof observePhase !== "function") {
      throw new Error("CLI execution phase observer is missing");
    }
    observePhase({ phase: "process_spawned" });
    expect(onRuntimeTurnStarted).not.toHaveBeenCalled();
    observePhase({ phase: "assistant_output_started" });
    expect(onRuntimeTurnStarted).toHaveBeenCalledOnce();
  });
}

export const CLI_BINDING_SETTLEMENT_OUTCOMES = [
  "rejected",
  "rejected-clear",
  "outer-fallback",
  "preserved-state",
  "preserved-same-native",
] as const;

export function createCliBindingSettlementCase(
  outcome: (typeof CLI_BINDING_SETTLEMENT_OUTCOMES)[number],
  localSessionId: string,
) {
  const sameNative = outcome === "preserved-same-native";
  const suppression: "preserved-state" | undefined =
    outcome === "preserved-state" || sameNative ? "preserved-state" : undefined;
  const outerFallback = outcome === "outer-fallback" || suppression !== undefined;
  const accepted = outerFallback;
  const previousBinding = {
    sessionId: "previous-native-session",
    ...(sameNative
      ? {
          resumeCheckpointId: "original-checkpoint",
          extraSystemPromptHash: "original-prompt",
          authEpoch: "original-account",
          transcriptCursor: {
            localSessionId,
            entryId: "prior-transcript",
            runId: "prior-run",
          },
        }
      : {}),
  };
  const transcriptCursor = {
    localSessionId,
    entryId: "handoff-tail",
    runId: "binding-parent",
    userEntryId: "completion-input",
  };
  const binding = {
    sessionId: sameNative ? previousBinding.sessionId : "settled-native-session",
    authProfileId: "anthropic:claude-cli",
    transcriptCursor,
    ...(sameNative
      ? {
          resumeCheckpointId: "completion-checkpoint",
          extraSystemPromptHash: "completion-prompt",
          authEpoch: "completion-account",
        }
      : {}),
  };
  const expectedBinding = sameNative
    ? { ...previousBinding, transcriptCursor }
    : suppression
      ? previousBinding
      : accepted
        ? binding
        : undefined;
  return { suppression, outerFallback, accepted, previousBinding, binding, expectedBinding };
}
