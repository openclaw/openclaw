import { createHash } from "node:crypto";
import {
  prependSystemPromptAdditionAfterCacheBoundary,
  splitSystemPromptRelocatableBoundary,
  stripSystemPromptCacheBoundary,
} from "@openclaw/ai/internal/shared";
import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  captureAnthropicRequest,
  registerParityHostLifecycle,
} from "../../../../packages/ai/src/provider-transport-parity.test-support.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { loadSessionEntryForAdmission } from "../../../config/sessions/session-accessor.sqlite-entry-admission.js";
import { entryFixture } from "../../../config/sessions/session-entry-fixture.test-support.js";
import * as historyWorker from "../../../config/sessions/session-transcript-worker-runtime.js";
import {
  clearMemoryPluginState,
  registerTestMemoryPromptBuilder,
} from "../../../plugins/memory-state.test-fixtures.js";
import * as sessionReader from "../../../sessions/session-controller.session-reader.js";
import {
  registerMainSessionGroupWatch,
  handleSessionStateSessionReset,
} from "../../../sessions/session-state-events.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { expectText } from "../../../test-utils/text-assertions.js";
import { normalizeSessionDeliveryState } from "../../../utils/delivery-context.shared.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { addSession, deleteSession } from "../../bash-process-registry.js";
import { createProcessSessionFixture } from "../../bash-process-registry.test-helpers.js";
import * as referencePaths from "../../docs-path.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../../harness/tool-surface-bridge.js";
import * as runtimePrompt from "../../runtime-prompt.js";
import type { AgentTool } from "../../runtime/index.js";
import { convertToLlm } from "../../sessions/messages.js";
import { buildSubagentSpawnEnvelope } from "../../subagents/spawn/subagent-system-prompt.js";
import { fakeTool } from "../../test-helpers/fake-tool.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import {
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
} from "../../tool-search-catalog.js";
import type { ToolSearchCatalogRef } from "../../tool-search-types.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { createEmptyPromptBootstrap } from "./attempt-system-prompt.test-support.js";
import { applyEmbeddedAttemptToolsAllow } from "./attempt-tool-construction-plan.js";
import { buildSystemUpdateMessage } from "./runtime-context-prompt.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

// Prompt assembly consumes a prepared provider handle; discovery belongs to attempt setup.
const providerRegistryMocks = vi.hoisted(() => {
  const rejectProviderDiscovery = () => {
    throw new Error("Prompt fixture unexpectedly discovered provider runtime");
  };
  return {
    isPluginProvidersLoadInFlight: vi.fn(rejectProviderDiscovery),
    resolvePluginProvidersCore: vi.fn(rejectProviderDiscovery),
  };
});

vi.mock("../../../plugins/providers.runtime-core.js", () => ({
  createProviderRegistryResolver: () => providerRegistryMocks,
}));

let prepareEmbeddedAttemptSystemPrompt: typeof import("./attempt-system-prompt-prepare.js").prepareEmbeddedAttemptSystemPrompt;
const admissions: Array<ReturnType<typeof prepareSystemAgentRunAdmission>> = [];

async function admitPrompt() {
  const admission = prepareSystemAgentRunAdmission(
    {},
    `prompt-fixture-${admissions.length}`,
    "main",
    "system-prompt-test",
  );
  admissions.push(admission);
  return admission.admit("embedded");
}

beforeAll(async () => {
  ({ prepareEmbeddedAttemptSystemPrompt } = await import("./attempt-system-prompt-prepare.js"));
});

afterEach(() => {
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  vi.restoreAllMocks();
  clearMemoryPluginState();
  providerRegistryMocks.isPluginProvidersLoadInFlight.mockClear();
  providerRegistryMocks.resolvePluginProvidersCore.mockClear();
});

const tool = (name: string) => fakeTool(name, name);

async function preparePermissionPrompt({
  codeModeActive = false,
  isRawModelRun = false,
  requireExplicitMessageTarget,
  session,
  skills,
  webSearchUnconfigured,
  attemptOverrides,
  toolSearchCatalogRef,
  suppliedTools,
  additionalToolNames = [],
}: {
  additionalToolNames?: string[];
  codeModeActive?: boolean;
  isRawModelRun?: boolean;
  requireExplicitMessageTarget?: boolean;
  session?: Pick<EmbeddedRunAttemptParams, "sessionKey" | "sandboxSessionKey">;
  skills?: { prompt: string; toolsAllow?: string[] };
  webSearchUnconfigured?: () => boolean;
  attemptOverrides?: Partial<EmbeddedRunAttemptParams>;
  toolSearchCatalogRef?: ToolSearchCatalogRef;
  suppliedTools?: AgentTool[];
} = {}) {
  const read = tool("read");
  const write = tool("write");
  const exec = tool("exec");
  const tools = suppliedTools ?? [
    ...additionalToolNames.map(tool),
    read,
    write,
    exec,
    ...(session ? [tool("process")] : []),
    ...(requireExplicitMessageTarget === undefined ? [] : [tool("message")]),
  ];
  const attempt = {
    provider: "openai",
    modelId: "gpt-5.6-luna",
    model: makeProviderModelFixture({
      id: "gpt-5.6-luna",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    }),
    permissionMode: "full",
    promptMode: "full",
    sessionId: "permission-prompt",
    sessionKey: "agent:main:permission-prompt",
    ...session,
    workspaceDir: "/tmp/openclaw",
    config: {},
    admittedRunContext: await admitPrompt(),
    toolsAllow: skills?.toolsAllow,
    sourceReplyDeliveryMode:
      requireExplicitMessageTarget === undefined ? undefined : "message_tool_only",
    requireExplicitMessageTarget,
    ...attemptOverrides,
  } as EmbeddedRunAttemptParams;
  const getProviderRuntimeHandle = vi.fn(() => ({
    provider: attempt.provider,
    modelId: attempt.modelId,
    prepared: true as const,
  }));
  const toolSurface = codeModeActive
    ? createAgentHarnessToolSurfaceRuntimeCore({
        config: { tools: { codeMode: true, toolSearch: false } },
        modelToolsEnabled: true,
        toolsAllow: attempt.toolsAllow,
        runtimeToolAllowlist: attempt.toolsAllow,
      })
    : undefined;
  if (toolSurface) {
    onTestFinished(() => toolSurface.cleanup());
  }
  const projectTools = (input: AgentTool[]) => {
    const allowedTools = applyEmbeddedAttemptToolsAllow(
      input,
      toolSurface?.runtimeToolAllowlist ?? attempt.toolsAllow,
    );
    return toolSurface
      ? toolSurface
          .compactTools(allowedTools, { localModelLeanApplied: true })
          .promptToolPolicy.apply()
      : { tools: allowedTools, callableToolNames: allowedTools.map(({ name }) => name) };
  };
  const projected = projectTools(tools);
  let effectiveTools = projected.tools;
  const capabilityToolNames = new Set(projected.callableToolNames);
  const prepared = await prepareEmbeddedAttemptSystemPrompt({
    attempt,
    activeContextEngine: undefined,
    bootstrap: createEmptyPromptBootstrap(),
    capabilityToolNames,
    effectiveTools,
    setup: createAttemptSetupFixture({
      effectiveCwd: "/tmp/openclaw",
      effectiveWorkspace: "/tmp/openclaw",
      getProviderRuntimeHandle,
      sandboxSessionKey: attempt.sandboxSessionKey ?? attempt.sessionKey ?? attempt.sessionId,
    }),
    isRawModelRun,
    modelToolsEnabled: true,
    skillsPrompt: skills?.prompt ?? "",
    codeModeActive: toolSurface?.codeModeControlsEnabled ?? false,
    webSearchUnconfigured,
    toolSearchDirectoryEnabled: false,
    toolSearchRuntimeConfig: attempt.config,
    toolSearchCatalogRef: toolSurface?.toolSearchCatalogRef ?? toolSearchCatalogRef,
  });
  return {
    attempt,
    capabilityToolNames,
    get effectiveTools() {
      return effectiveTools;
    },
    prepared,
    getProviderRuntimeHandle,
    read,
    refreshSystemPrompt: async (prompt: string, refreshedTools: AgentTool[]) => {
      const refreshed = projectTools(refreshedTools);
      effectiveTools = refreshed.tools;
      if (toolSurface) {
        capabilityToolNames.clear();
        for (const name of refreshed.callableToolNames) {
          capabilityToolNames.add(name);
        }
      }
      return (await prepared.prepareToolPrompt!(effectiveTools, { permissionChanged: true }))(
        prompt,
      );
    },
    write,
  };
}

describe("buildAttemptSystemPrompt", () => {
  registerParityHostLifecycle();

  it("prepares current public links without materializing saved prompt snapshots", async () => {
    await withOpenClawTestState({ label: "prompt-link-projection" }, async ({ env }) => {
      const config = { gateway: { publicOrigin: "https://gateway.example" } };
      setRuntimeConfigSnapshot(config);
      const store = entryFixture(env, "dashboard:public-link");
      const entry = {
        sessionId: "public-link",
        lifecycleRevision: "first",
        updatedAt: 1,
        publicShare: { id: "a".repeat(48), sessionId: "public-link", createdAt: 1 },
        skillsSnapshot: { prompt: "Saved skill instructions.\n".repeat(8_192), skills: [] },
      };
      store.replace(entry);
      const { databaseClaim } = await loadSessionEntryForAdmission(store.scope);
      try {
        if (!("reader" in databaseClaim) || !databaseClaim.reader) {
          throw new Error("Prompt fixture did not admit a durable session reader");
        }
        const reader = databaseClaim.reader;
        vi.spyOn(sessionReader, "getReplyOperationSessionReader").mockReturnValue(reader);
        // A metadata publication must not send the prompt back to the worker for saved snapshots.
        store.database.db
          .prepare("UPDATE session_nodes SET entry_json = entry_json WHERE session_key = ?")
          .run(store.sessionKey);
        await reader.readEntry(() => {}, "list");
        const workerReads = vi.spyOn(historyWorker, "withSessionHistoryWorkerDatabase");
        const readEntry = reader.readEntry.bind(reader);
        let snapshotMaterializations = 0;
        vi.spyOn(reader, "readEntry").mockImplementation(async (...args) => {
          const result = await readEntry(...args);
          snapshotMaterializations += Number(result.entry.skillsSnapshot !== undefined);
          return result;
        });
        const prepare = () =>
          preparePermissionPrompt({
            attemptOverrides: { config, sessionKey: store.sessionKey, sessionId: entry.sessionId },
          });
        const published = await prepare();
        const sessionUrl = "https://gateway.example/chat/main/dashboard/public-link";
        expect(published.prepared.runtimeInfo).toHaveProperty("sessionUrl", sessionUrl);
        expect(published.prepared.systemPromptText).toContain(sessionUrl);
        const initialWorkerReads = workerReads.mock.calls.length;
        store.replace({ ...entry, publicShare: undefined });
        const revoked = await prepare();
        expect(revoked.prepared.runtimeInfo).toHaveProperty("sessionUrl", undefined);
        expect(revoked.prepared.systemPromptText).not.toContain(
          "https://gateway.example/chat/main/dashboard/public-link",
        );
        store.replace({ ...entry, sessionId: "replacement", lifecycleRevision: "second" });
        await expect(prepare()).rejects.toThrow(/changed|replaced|revoked/i);
        expect(initialWorkerReads).toBe(0);
        expect(snapshotMaterializations).toBe(0);
      } finally {
        await databaseClaim.release();
      }
    });
  });

  it.each(["conversation", "ephemeral", "persistent", "leaf"] as const)(
    "preserves the provider prefix and standing policy across %s follow-ups",
    async (kind) =>
      withOpenClawTestState({ label: `suffix-${kind}` }, async () => {
        const config = { agents: { defaults: { subagents: { maxSpawnDepth: 2 } } } };
        setRuntimeConfigSnapshot(config);
        const childSessionKey = `agent:main:subagent:prefix-${kind}`;
        const childDepth = kind === "leaf" ? 2 : 1;
        const spawnMode = kind === "persistent" ? "session" : "run";
        if (kind !== "conversation") {
          await upsertSessionEntryCore(
            { sessionKey: childSessionKey },
            {
              sessionId: "prefix-fixture",
              updatedAt: 1,
              spawnDepth: childDepth,
            },
          );
        }
        const requests: Record<string, unknown>[] = [];
        const messages: Parameters<typeof convertToLlm>[0] = [];
        const child = buildSubagentSpawnEnvelope({
          completionMode: kind === "persistent" ? "thread-direct" : "collector",
          spawnMode,
          childDepth,
          maxSpawnDepth: 2,
          task: "Inspect synthetic inputs.",
          childSessionKey,
        });
        for (const turn of ["operator", "completion"]) {
          if (kind !== "conversation" && turn === "completion") {
            const { addSubagentRunForTests } =
              await import("../../subagents/registry/subagent-registry.test-helpers.js");
            onTestFinished(async () => {
              const { resetSubagentRegistryForTests } =
                await import("../../subagents/registry/subagent-registry.test-helpers.js");
              await resetSubagentRegistryForTests({ persist: false });
            });
            await addSubagentRunForTests({
              runId: `prefix-${kind}-run`,
              childSessionKey,
              childAgentId: "main",
              spawnMode,
              endedAt: 2,
            });
          }
          const context = `Current conversation: ${turn}. Use this turn's delivery target.`;
          const { prepared } = await preparePermissionPrompt({
            attemptOverrides:
              kind === "conversation"
                ? {
                    extraSystemPrompt: `Persistent policy.\n\n${context}\n\nLater configured guidance.`,
                    extraSystemPromptTurnContext: {
                      start: "Persistent policy.\n\n".length,
                      text: context,
                    },
                  }
                : {
                    sessionKey: childSessionKey,
                    promptMode: "minimal",
                    config,
                    cleanupBundleMcpOnRunEnd:
                      turn === "operator" ? spawnMode !== "session" : undefined,
                    extraSystemPrompt: turn === "operator" ? child.systemPrompt : undefined,
                  },
          });
          messages.push({
            role: "user",
            content:
              kind !== "conversation" && turn === "operator" ? child.message : `Handle ${turn}`,
            timestamp: 1,
          });
          for (const fragment of prepared.runtimeContextFragments ?? []) {
            messages.push(buildSystemUpdateMessage(fragment.text, "runtime-context", true));
          }
          const { payload } = await captureAnthropicRequest("transport", {
            model: { id: "claude-opus-4-6" },
            cacheRetention: "none",
            context: { systemPrompt: prepared.systemPromptText, messages: convertToLlm(messages) },
          });
          requests.push(payload);
          const system = JSON.stringify(payload.system);
          if (kind === "conversation") {
            expect(system).toContain("Persistent policy.");
            expect(system).toContain("Later configured guidance.");
            expect(system).not.toContain(context);
            expect(JSON.stringify(payload.messages)).toContain(context);
          } else {
            for (const rule of [
              "## Your Role",
              "Focus: assigned task only.",
              "## Output Format",
              "No automations/persistent state.",
              kind === "leaf"
                ? "Leaf worker: cannot spawn. Assigned task only."
                : "May delegate descendants for parallel/complex work. Decide local vs child ownership.",
              `- You are not ${kind === "leaf" ? "parent orchestrator" : "main agent"}.`,
            ]) {
              expect(system).toContain(rule);
            }
            expect(system.includes("4. Ephemeral: termination after completion is normal.")).toBe(
              spawnMode === "run",
            );
            expect(system).not.toContain("apply only to this turn");
            expect(system).not.toContain("Inspect synthetic inputs.");
            expect(system.match(/(?<!#)# Subagent Context/g)).toHaveLength(1);
          }
        }
        expect(JSON.stringify(requests[1]!.system)).toBe(JSON.stringify(requests[0]!.system));
        const firstMessages = requests[0]!.messages as unknown[];
        expect((requests[1]!.messages as unknown[]).slice(0, firstMessages.length)).toEqual(
          firstMessages,
        );
      }),
  );

  it("keeps watched membership and titles out of the system prefix across turns and refresh", async () => {
    await withOpenClawTestState({ label: "watched-turn-context" }, async () => {
      setRuntimeConfigSnapshot({});
      const sessionKey = "agent:main:main";
      const groupKey = "agent:main:telegram:group:fixture";
      const prepare = () =>
        preparePermissionPrompt({
          session: { sessionKey },
          additionalToolNames: ["sessions_history", "sessions_list"],
        });
      const empty = await prepare();
      const noWatches = [{ kind: "conversation-data", text: "## Watched Sessions\nnone" }];
      expect(await registerMainSessionGroupWatch({ sessionKey: groupKey, agentId: "main" })).toBe(
        true,
      );
      await upsertSessionEntryCore(
        { sessionKey: groupKey },
        {
          sessionId: "watched-fixture",
          displayName: "Original room",
          updatedAt: 1,
        },
      );
      const watched = await prepare();
      expect(watched.prepared.systemPromptText).toBe(empty.prepared.systemPromptText);
      expect(empty.prepared.runtimeContextFragments).toEqual(noWatches);
      expect(watched.prepared.runtimeContextFragments).toEqual([
        {
          kind: "conversation-data",
          text: expect.stringContaining(`${groupKey} — Original room`),
        },
      ]);
      await upsertSessionEntryCore(
        { sessionKey: groupKey },
        {
          sessionId: "watched-fixture",
          displayName: "Renamed room",
          updatedAt: 2,
        },
      );
      const renamed = await prepare();
      expect(renamed.prepared.systemPromptText).toBe(empty.prepared.systemPromptText);
      expect(renamed.prepared.runtimeContextFragments?.[0]?.text).toContain("Renamed room");
      // Permission/tool refresh must not reintroduce a volatile system section.
      const refresh = await watched.prepared.prepareToolPrompt!([watched.read]);
      expect(refresh(watched.prepared.systemPromptText)).not.toContain(groupKey);
      expect(watched.prepared.runtimeContextFragments?.[0]?.text).toContain("Renamed room");
      watched.capabilityToolNames.clear();
      const revoke = await watched.prepared.prepareToolPrompt!([watched.read]);
      revoke(watched.prepared.systemPromptText);
      expect(watched.prepared.runtimeContextFragments).toEqual([]);
      for (const options of [
        { isRawModelRun: true },
        { attemptOverrides: { promptMode: "minimal" as const } },
        { skills: { prompt: "", toolsAllow: ["read"] } },
      ]) {
        const excluded = await preparePermissionPrompt({
          ...options,
          session: { sessionKey },
          additionalToolNames: ["sessions_history"],
        });
        expect(excluded.prepared.systemPromptText).not.toContain(groupKey);
        expect(excluded.prepared.runtimeContextFragments).toEqual([]);
      }
      await handleSessionStateSessionReset(sessionKey);
      const removed = await prepare();
      expect(removed.prepared.systemPromptText).toBe(empty.prepared.systemPromptText);
      expect(removed.prepared.runtimeContextFragments).toEqual(noWatches);
    });
  });

  it("refreshes deferred reporting only when the prepared catalog is accepted", async () => {
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [tool("deferred")] });
    onTestFinished(() => clearToolSearchCatalog({ catalogRef }));
    const { prepared } = await preparePermissionPrompt({ toolSearchCatalogRef: catalogRef });
    expect(prepared.systemPromptReport?.tools.deferred?.entries.map((entry) => entry.name)).toEqual(
      ["deferred"],
    );
    catalogRef.current!.entries = [];
    const refresh = await prepared.prepareToolPrompt!();
    expect(prepared.systemPromptReport?.tools.deferred?.entries).toHaveLength(1);
    refresh(prepared.systemPromptText);
    expect(prepared.systemPromptReport?.tools.deferred?.entries).toEqual([]);
    expect(
      prepared.systemPromptReport?.tools.entries.some((entry) => entry.name === "deferred"),
    ).toBe(false);
  });

  it("carries the prepared missing-search fact into the actual initial prompt and tool refresh", async () => {
    let missing = true;
    const { prepared, read, refreshSystemPrompt } = await preparePermissionPrompt({
      webSearchUnconfigured: () => missing,
    });
    expectText(prepared.systemPromptText, [
      "Current model identity: openai/gpt-5.6-luna.",
      "Web search is supported but not configured.",
      "openclaw configure --section web",
    ]);
    missing = false;
    expect(await refreshSystemPrompt(prepared.systemPromptText, [read])).not.toContain(
      "Web search is supported but not configured.",
    );
  });

  const skillsCatalog = "<available_skills><skill><name>weather</name></skill></available_skills>";

  it.each([
    ["native reader", false, ["read"], ["read"], true],
    ["skill reader", false, ["skills_read"], ["skills_read"], true],
    ["excluded reader", false, ["write"], ["write", "read"], false],
    ["unavailable reader", false, ["write", "read"], ["write"], false],
    ["tool-less routine", false, [], ["read"], false],
    ["Code Mode without reader", true, ["write"], ["write", "read", "skills_read"], false],
    ["Code Mode reader", true, ["write", "skills_read"], ["write", "skills_read"], true],
  ] as const)(
    "includes routine skills only with an executable reader: %s",
    async (_label, codeModeActive, toolsAllow, toolNames, expected) => {
      const fixture = await preparePermissionPrompt({
        codeModeActive,
        session: { sessionKey: "agent:main:cron:skill-reader:run:fixture" },
        suppliedTools: toolNames.map(tool),
        skills: { prompt: skillsCatalog, toolsAllow: [...toolsAllow] },
      });
      const { prepared, effectiveTools, capabilityToolNames } = fixture;
      const { systemPromptText, systemPromptReport } = prepared;
      const { payload } = await captureAnthropicRequest("transport", {
        context: {
          systemPrompt: systemPromptText,
          tools: effectiveTools,
          messages: [{ role: "user", content: "Check the weather.", timestamp: 1 }],
        },
      });
      const system = JSON.stringify(payload.system);
      expect(system.includes(skillsCatalog)).toBe(expected);
      expect(system.includes("skills.read(")).toBe(codeModeActive && expected);
      expect(systemPromptReport?.skills.entries.map(({ name }) => name)).toEqual(
        expected ? ["weather"] : [],
      );
      if (codeModeActive) {
        expect(payload.tools).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: "exec" })]),
        );
        expect(capabilityToolNames.has("write")).toBe(true);
        expect(capabilityToolNames.has("read")).toBe(false);
        expect(system).not.toContain("read exact <location>");
      } else {
        expect(/"name":"(?:read|skills_read)"/.test(JSON.stringify(payload.tools))).toBe(expected);
      }
      const refreshed = await fixture.refreshSystemPrompt(systemPromptText, toolNames.map(tool));
      expect(refreshed.includes(skillsCatalog)).toBe(expected);
      expect(systemPromptReport?.skills.entries.map(({ name }) => name)).toEqual(
        expected ? ["weather"] : [],
      );
    },
  );

  it.each([false, true])(
    "refreshes reader diagnostics and hook overrides (Code Mode=%s)",
    async (codeModeActive) => {
      const reader = tool(codeModeActive ? "skills_read" : "read");
      const write = tool("write");
      const fixture = await preparePermissionPrompt({
        codeModeActive,
        suppliedTools: [write, reader],
        skills: { prompt: skillsCatalog, toolsAllow: ["write", reader.name] },
      });
      const { prepared, refreshSystemPrompt } = fixture;
      expect(prepared.systemPromptText).toContain(skillsCatalog);
      const hidden = await refreshSystemPrompt(prepared.systemPromptText, [write]);
      expect(hidden).not.toContain(skillsCatalog);
      expect(hidden).not.toContain("read exact <location>");
      expect(prepared.systemPromptReport?.skills.promptChars).toBe(0);
      expect(fixture.effectiveTools.some(({ name }) => name === "exec")).toBe(codeModeActive);

      const restored = await refreshSystemPrompt(hidden, [write, reader]);
      expect(restored).toContain(skillsCatalog);
      expect(fixture.effectiveTools.some(({ name }) => name === "exec")).toBe(codeModeActive);
      expect(prepared.systemPromptReport?.skills.entries.map(({ name }) => name)).toEqual([
        "weather",
      ]);
      expect(prepared.systemPromptReport?.skills.hash).toBe(
        createHash("sha256").update(skillsCatalog).digest("hex"),
      );
      const overridden = await refreshSystemPrompt("Use the deliberate hook override.", [
        write,
        reader,
      ]);
      expect(overridden).not.toContain(skillsCatalog);
      expect(prepared.systemPromptReport?.skills.promptChars).toBe(0);
      expect(prepared.systemPromptReport?.skills.entries).toEqual([]);
    },
  );

  it("keeps the system prompt identical when execution-owned processes change", async () => {
    const owned = createProcessSessionFixture({ id: "execution-owned", backgrounded: true });
    owned.scopeKey = "permission-prompt";
    const other = createProcessSessionFixture({ id: "policy-owned", backgrounded: true });
    other.scopeKey = "agent:main:policy";
    const session = {
      sessionKey: undefined,
      sandboxSessionKey: other.scopeKey,
    };
    const idle = await preparePermissionPrompt({ session });
    addSession(owned);
    addSession(other);
    try {
      const { prepared } = await preparePermissionPrompt({ session });
      expect(prepared.systemPromptText).toBe(idle.prepared.systemPromptText);
      expect(prepared.systemPromptText).not.toContain(owned.id);
      expect(prepared.systemPromptText).not.toContain(other.id);
    } finally {
      deleteSession(owned.id);
      deleteSession(other.id);
    }
  });

  it("keeps model instructions identical when only reasoning effort changes", async () => {
    const prompts = [];
    for (const effort of ["low", "high", "medium"] as const) {
      prompts.push(
        (await preparePermissionPrompt({ attemptOverrides: { thinkLevel: effort } })).prepared
          .systemPromptText,
      );
    }
    expect(prompts[0]).not.toBe("");
    expect(prompts[1]).toBe(prompts[0]);
    expect(prompts[2]).toBe(prompts[0]);
  });

  it("marks rebuilt prompts as fresh even when restoring the original bytes", async () => {
    const { prepared, read } = await preparePermissionPrompt();
    const original = prepared.systemPromptText;
    const unchanged = await prepared.prepareToolPrompt!();
    expect(unchanged.freshlyRendered).toBeUndefined();
    expect(unchanged("Already projected prompt")).toBe("Already projected prompt");

    const restrict = await prepared.prepareToolPrompt!([read]);
    expect(restrict.freshlyRendered).toBe(true);
    const restricted = restrict(original);
    expect(restricted).not.toBe(original);

    const restore = await prepared.prepareToolPrompt!();
    expect(restore.freshlyRendered).toBe(true);
    expect(restore(restricted)).toBe(original);
  });

  it("replaces an intermediate permission prompt after later changes", async () => {
    const fixture = await preparePermissionPrompt();
    const { attempt, capabilityToolNames, prepared, read, refreshSystemPrompt, write } = fixture;
    const initialPrompt = prepared.systemPromptText;
    expectText(initialPrompt, ["- exec:", "exec approval-pending:"]);

    attempt.permissionMode = "workspace";
    capabilityToolNames.delete("exec");
    const currentTools = [read, write];
    const preparation = prepared.prepareToolPrompt!(currentTools, { permissionChanged: true });
    expect(prepared.prepareToolPrompt!(currentTools, { permissionChanged: true })).toBe(
      preparation,
    );
    const intermediatePrompt = (await preparation)(initialPrompt);
    expectText(intermediatePrompt, ["- write:"], ["- exec:"]);

    attempt.permissionMode = "read-only";
    capabilityToolNames.delete("write");
    await refreshSystemPrompt(intermediatePrompt, [read]);
    // The delayed hook retained B while the live owner already advanced to C.
    const delayedHookPrompt = prependSystemPromptAdditionAfterCacheBoundary({
      systemPrompt: `Hook prefix\n\n${intermediatePrompt}\n\nHook suffix`,
      systemPromptAddition: "Current runtime addition",
    });
    const refreshed = await refreshSystemPrompt(delayedHookPrompt, [read]);
    expectText(
      refreshed,
      [
        "- read:",
        "Hook prefix",
        "Hook suffix",
        "Current runtime addition",
        "permissions to read-only",
      ],
      ["- write:", "- exec:", "exec approval-pending:", "permissions to workspace"],
    );
    expect(refreshed.match(/## Permission change/g)).toHaveLength(1);
    expect(await refreshSystemPrompt(refreshed, [read])).toBe(refreshed);
  });

  it("preserves explicit hook overrides while replacing their stale permission notice", async () => {
    const { attempt, read, refreshSystemPrompt } = await preparePermissionPrompt();
    attempt.permissionMode = "workspace";
    const overridden = await refreshSystemPrompt("Use the deliberate hook override.", [read]);
    attempt.permissionMode = "guarded";
    await refreshSystemPrompt(overridden, [read]);
    attempt.permissionMode = "read-only";
    const refreshed = await refreshSystemPrompt(overridden, [read]);

    expectText(
      refreshed,
      ["Use the deliberate hook override.", "permissions to read-only"],
      ["## Tooling", "permissions to workspace"],
    );
    expect(refreshed.match(/## Permission change/g)).toHaveLength(1);
  });

  it("keeps an appended permission notice out of the relocatable region", async () => {
    // `refreshSystemPrompt` appends its PERMISSION section after the built
    // prompt. The relocatable region is closed before that, so a transport that
    // carries the region onto a user turn cannot demote the notice with it.
    const { prepared, read, refreshSystemPrompt } = await preparePermissionPrompt();
    const refreshed = await refreshSystemPrompt(prepared.systemPromptText, [read]);
    expect(refreshed).toContain("<!-- openclaw:attempt:PERMISSION -->");

    const split = splitSystemPromptRelocatableBoundary(refreshed);

    expect(split?.relocatable).toContain("Runtime:");
    expect(split?.relocatable).not.toContain("PERMISSION");
    expect(split?.remainingPrompt).toContain("<!-- openclaw:attempt:PERMISSION -->");
    expect(stripSystemPromptCacheBoundary(refreshed)).not.toContain(
      "OPENCLAW-RELOCATABLE-BOUNDARY",
    );
  });

  it("does not inject permission guidance into raw model prompts", async () => {
    const { attempt, prepared, read, refreshSystemPrompt } = await preparePermissionPrompt({
      isRawModelRun: true,
    });
    attempt.permissionMode = "read-only";
    expect(prepared.systemPromptText).toBe("");
    expect(await refreshSystemPrompt("", [read])).toBe("");
  });

  it("does not invoke ambient contributors during settled finalization", async () => {
    const getProviderRuntimeHandle = vi.fn();
    const markStage = vi.fn();
    const setup = createAttemptSetupFixture({ getProviderRuntimeHandle });
    setup.prepStages.mark = markStage;
    const result = await prepareEmbeddedAttemptSystemPrompt({
      attempt: { operation: "settled-tool-finalization" },
      setup,
    } as never);

    expect(result.systemPromptText).toBe("");
    expect(result.runtimeChannel).toBeUndefined();
    expect(getProviderRuntimeHandle).not.toHaveBeenCalled();
    expect(markStage).toHaveBeenCalledWith("system-prompt");
  });

  it.each([
    ["detached model run", true, undefined, true, true, false],
    ["detached prompt-none run", undefined, "none", true, true, false],
    ["durable raw run", true, undefined, false, true, true],
    ["detached ordinary run", undefined, undefined, true, true, true],
    ["detached tool-capable raw run", true, undefined, true, false, true],
  ] as const)(
    "prepares only the required ambient context for %s",
    async (_label, modelRun, promptMode, detached, disableTools, ambient) => {
      const resolveRuntime = vi.spyOn(runtimePrompt, "resolveAgentRuntimePrompt");
      const resolveReferences = vi.spyOn(referencePaths, "resolveOpenClawReferencePaths");
      const { prepared, getProviderRuntimeHandle } = await preparePermissionPrompt({
        suppliedTools: [],
        isRawModelRun: modelRun === true || promptMode === "none",
        attemptOverrides: {
          permissionMode: undefined,
          workspaceDir: undefined,
          runId: "raw-prompt-run",
          sessionId: "raw-prompt",
          sessionKey: "agent:main:raw-prompt",
          sessionPersistence: detached ? "detached" : "durable",
          modelRun,
          promptMode,
          disableTools,
        },
      });

      if (ambient) {
        expect(resolveRuntime).toHaveBeenCalledOnce();
        expect(resolveReferences).toHaveBeenCalledOnce();
        expect(prepared.systemPromptReport).toBeDefined();
      } else {
        expect(resolveRuntime).not.toHaveBeenCalled();
        expect(resolveReferences).not.toHaveBeenCalled();
        expect(getProviderRuntimeHandle).not.toHaveBeenCalled();
        expect(prepared.systemPromptText).toBe("");
        expect(prepared.systemPromptReport).toBeUndefined();
        expect(prepared.runtimeInfo).toEqual({ model: "openai/gpt-5.6-luna" });
      }
    },
  );

  it("leaves project annotation guidance to the selected memory plugin", async () => {
    const seenProjectKeys: Array<string | undefined> = [];
    registerTestMemoryPromptBuilder((params) => {
      seenProjectKeys.push(params.projectKey);
      return ["## Provider Memory", "PROVIDER_MEMORY_MARKER"];
    });
    const { prepared } = await preparePermissionPrompt({
      attemptOverrides: {
        preparedModelRuntime: {
          projectKey: "github.com/acme/Alpha",
          activeProjectKeys: [],
          configuredModelAliases: [],
          isCurrent: () => true,
        } as unknown as EmbeddedRunAttemptParams["preparedModelRuntime"],
      },
    });

    expect(seenProjectKeys).toContain("github.com/acme/Alpha");
    expectText(prepared.systemPromptText, ["PROVIDER_MEMORY_MARKER"], ["<!-- project:"]);
  });
});

describe("embedded session prompt delivery", () => {
  // Provider prefix caches need one system prompt per session; turn delivery rules
  // that differ (heartbeats, completions) travel in the turn's runtime context.
  it.each([false, true])(
    "keeps the user turn's system prompt with explicit target=%s",
    async (requireExplicitMessageTarget) => {
      const turn = {
        sourceReplyDeliveryMode: "message_tool_only" as const,
        requireExplicitMessageTarget,
      };
      const user = await preparePermissionPrompt({
        requireExplicitMessageTarget: false,
        attemptOverrides: { sourceReplyDeliveryMode: "automatic" },
      });
      const synthetic = await preparePermissionPrompt({
        requireExplicitMessageTarget: false,
        attemptOverrides: turn,
      });
      expect(synthetic.prepared.systemPromptText).toBe(user.prepared.systemPromptText);
      expect(
        synthetic.prepared.runtimeContextFragments?.map((fragment) => fragment.text).join("\n"),
      ).toMatch(
        turn.requireExplicitMessageTarget
          ? /final text is private[\s\S]*target required this turn/u
          : /final text is private/u,
      );
    },
  );

  it("overrides a saved group's message-tool policy for an automatic CLI reply", async () => {
    const shared = {
      config: { messages: { groupChat: { visibleReplies: "message_tool" as const } } },
      sessionPromptDelivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", to: "-100123" },
        origin: { provider: "telegram", surface: "telegram", chatType: "group" },
      }),
    };
    const user = await preparePermissionPrompt({
      requireExplicitMessageTarget: false,
      attemptOverrides: {
        ...shared,
        messageChannel: "telegram",
        chatType: "group",
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });
    const cli = await preparePermissionPrompt({
      requireExplicitMessageTarget: false,
      attemptOverrides: { ...shared, sourceReplyDeliveryMode: undefined },
    });
    expect(cli.prepared.systemPromptText).toBe(user.prepared.systemPromptText);
    expect(cli.prepared.systemPromptText).toContain("MUST use `message(action=send)`");
    expect(
      cli.prepared.runtimeContextFragments?.map((fragment) => fragment.text).join("\n"),
    ).toContain("This turn's final text goes to the current source automatically.");
    expect(user.prepared.runtimeContextFragments).toEqual([]);
  });
});
