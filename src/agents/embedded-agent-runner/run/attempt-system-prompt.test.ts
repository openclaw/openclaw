import { createHash } from "node:crypto";
import {
  prependSystemPromptAdditionAfterCacheBoundary,
  splitSystemPromptRelocatableBoundary,
  stripSystemPromptCacheBoundary,
} from "@openclaw/ai/internal/shared";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import {
  clearMemoryPluginState,
  registerTestMemoryPromptBuilder,
} from "../../../plugins/memory-state.test-fixtures.js";
import {
  registerMainSessionGroupWatch,
  handleSessionStateSessionReset,
} from "../../../sessions/session-state-events.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { addSession, deleteSession } from "../../bash-process-registry.js";
import { createProcessSessionFixture } from "../../bash-process-registry.test-helpers.js";
import { buildBootstrapBudgetState } from "../../bootstrap-budget.js";
import * as referencePaths from "../../docs-path.js";
import * as runtimePrompt from "../../runtime-prompt.js";
import type { AgentTool } from "../../runtime/index.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import type { ToolSearchCatalogRef } from "../../tool-search-types.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { buildAttemptSystemPrompt } from "./attempt-system-prompt.js";
import { buildTurnDeliveryContextFragments } from "./turn-delivery-context.js";
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

async function admitPrompt(
  config: NonNullable<EmbeddedRunAttemptParams["config"]>,
  agentId = "main",
) {
  const admission = prepareSystemAgentRunAdmission(
    config,
    `prompt-fixture-${admissions.length}`,
    agentId,
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

const identityFiles = ["SOUL", "IDENTITY", "USER"].map((name) => ({
  path: `/tmp/openclaw/${name}.md`,
  content: `${name}_CONTEXT_MARKER`,
}));
function expectText(text: string, included: string[], excluded: string[] = []) {
  for (const value of included) {
    expect(text).toContain(value);
  }
  for (const value of excluded) {
    expect(text).not.toContain(value);
  }
}

function buildPrompt(
  overrides: Partial<Parameters<typeof buildAttemptSystemPrompt>[0]["embeddedSystemPrompt"]>,
) {
  return buildAttemptSystemPrompt({
    isRawModelRun: false,
    transformSystemPrompt: (prompt) => prompt,
    embeddedSystemPrompt: {
      workspaceDir: "/tmp/openclaw",
      reasoningTagHint: false,
      runtimeInfo: {
        host: "test-host",
        os: "Darwin",
        arch: "arm64",
        node: "v22.0.0",
        model: "openai/gpt-5.5",
      },
      tools: [],
      modelAliasLines: [],
      ...overrides,
    },
  });
}

async function preparePermissionPrompt({
  isRawModelRun = false,
  thinkLevel,
  requireExplicitMessageTarget,
  session,
  skills,
  webSearchUnconfigured,
  attemptOverrides,
  toolSearchCatalogRef,
  additionalToolNames = [],
}: {
  additionalToolNames?: string[];
  isRawModelRun?: boolean;
  thinkLevel?: EmbeddedRunAttemptParams["thinkLevel"];
  requireExplicitMessageTarget?: boolean;
  session?: Pick<EmbeddedRunAttemptParams, "sessionKey" | "sandboxSessionKey">;
  skills?: { prompt: string; toolsAllow?: string[]; initialToolNames?: string[] };
  webSearchUnconfigured?: () => boolean;
  attemptOverrides?: Partial<EmbeddedRunAttemptParams>;
  toolSearchCatalogRef?: ToolSearchCatalogRef;
} = {}) {
  const tool = (name: string): AgentTool => ({
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: {} }),
  });
  const read = tool("read");
  const write = tool("write");
  const exec = tool("exec");
  const tools = [
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
    admittedRunContext: await admitPrompt({}),
    thinkLevel,
    toolsAllow: skills?.toolsAllow,
    sourceReplyDeliveryMode:
      requireExplicitMessageTarget === undefined ? undefined : "message_tool_only",
    requireExplicitMessageTarget,
    ...attemptOverrides,
  } as EmbeddedRunAttemptParams;
  const capabilityToolNames = new Set(tools.map(({ name }) => name));
  const prepared = await prepareEmbeddedAttemptSystemPrompt({
    attempt,
    activeContextEngine: undefined,
    bootstrap: {
      ...buildBootstrapBudgetState({ files: [] }),
      bootstrapMode: "full",
      contextFiles: [],
      bootstrapInjectionStats: [],
      shouldRecordCompletedBootstrapTurn: false,
      workspaceNotes: [],
    },
    capabilityToolNames,
    effectiveTools: skills?.initialToolNames
      ? tools.filter(({ name }) => skills.initialToolNames?.includes(name))
      : tools,
    setup: createAttemptSetupFixture({
      effectiveCwd: "/tmp/openclaw",
      effectiveWorkspace: "/tmp/openclaw",
      getProviderRuntimeHandle: () => ({
        provider: attempt.provider,
        modelId: attempt.modelId,
        prepared: true,
      }),
      sandboxSessionKey: attempt.sandboxSessionKey ?? attempt.sessionKey ?? attempt.sessionId,
    }),
    isRawModelRun,
    modelToolsEnabled: true,
    skillsPrompt: skills?.prompt ?? "",
    webSearchUnconfigured,
    toolSearchDirectoryEnabled: false,
    toolSearchRuntimeConfig: attempt.config,
    toolSearchCatalogRef,
  });
  if (!prepared.prepareToolPrompt) {
    throw new Error("Expected a refreshable attempt prompt");
  }
  return {
    attempt,
    capabilityToolNames,
    prepared,
    read,
    refreshSystemPrompt: async (prompt: string, refreshedTools: AgentTool[]) =>
      (await prepared.prepareToolPrompt!(refreshedTools, { permissionChanged: true }))(prompt),
    write,
  };
}

describe("buildAttemptSystemPrompt", () => {
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
    const deferred: AgentTool = {
      name: "deferred",
      label: "Deferred",
      description: "Deferred",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    };
    const catalogRef: ToolSearchCatalogRef = {
      current: {
        counterScope: "test",
        searchCount: 0,
        describeCount: 0,
        callCount: 0,
        entries: [
          {
            id: "openclaw:core:deferred",
            name: deferred.name,
            source: "openclaw",
            sourceName: "core",
            description: deferred.description,
            parameters: deferred.parameters,
            tool: deferred,
          },
        ],
      },
    };
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
      "Web search is supported but not configured.",
      "openclaw configure --section web",
    ]);
    missing = false;
    expect(await refreshSystemPrompt(prepared.systemPromptText, [read])).not.toContain(
      "Web search is supported but not configured.",
    );
  });

  const skillsCatalog = "<available_skills><skill><name>weather</name></skill></available_skills>";

  it("refreshes skill diagnostics when read visibility changes or hooks replace the prompt", async () => {
    const { prepared, read, refreshSystemPrompt } = await preparePermissionPrompt({
      skills: { prompt: skillsCatalog },
    });
    const hidden = await refreshSystemPrompt(prepared.systemPromptText, []);
    expect(hidden).not.toContain(skillsCatalog);
    expect(prepared.systemPromptReport?.skills.promptChars).toBe(0);

    const restored = await refreshSystemPrompt(hidden, [read]);
    expect(restored).toContain(skillsCatalog);
    expect(prepared.systemPromptReport?.skills.entries.map(({ name }) => name)).toEqual([
      "weather",
    ]);
    expect(prepared.systemPromptReport?.skills.hash).toBe(
      createHash("sha256").update(skillsCatalog).digest("hex"),
    );

    const overridden = await refreshSystemPrompt("Use the deliberate hook override.", [read]);
    expect(overridden).not.toContain(skillsCatalog);
    expect(prepared.systemPromptReport?.skills.promptChars).toBe(0);
    expect(prepared.systemPromptReport?.skills.entries).toEqual([]);
  });

  it("reports read becoming visible while preserving attempt tool policy", async () => {
    const toolsAllow = ["message"];
    const { prepared, read, refreshSystemPrompt } = await preparePermissionPrompt({
      skills: { prompt: skillsCatalog, toolsAllow, initialToolNames: [] },
    });
    expect(prepared.systemPromptText).not.toContain(skillsCatalog);
    expect(prepared.systemPromptReport?.skills.promptChars).toBe(0);

    const refreshed = await refreshSystemPrompt(prepared.systemPromptText, [read]);
    expect(refreshed).not.toContain(skillsCatalog);
    expect(prepared.systemPromptReport?.skills.promptChars).toBe(0);
    expect(prepared.systemPromptReport?.skills.entries).toEqual([]);
  });

  it.each([undefined])(
    "keeps the system prompt identical when execution-owned processes change: %s",
    async (sessionKey) => {
      const owned = createProcessSessionFixture({ id: "execution-owned", backgrounded: true });
      owned.scopeKey = sessionKey ?? "permission-prompt";
      const other = createProcessSessionFixture({ id: "policy-owned", backgrounded: true });
      other.scopeKey = "agent:main:policy";
      const session = {
        sessionKey,
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
    },
  );

  it("keeps model instructions identical when only reasoning effort changes", async () => {
    const prompts = [];
    for (const effort of ["low", "high", "medium"] as const) {
      prompts.push(
        (await preparePermissionPrompt({ thinkLevel: effort })).prepared.systemPromptText,
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
    {
      label: "detached model run",
      modelRun: true,
      detached: true,
      disableTools: true,
      ambient: false,
    },
    {
      label: "detached prompt-none run",
      promptMode: "none" as const,
      detached: true,
      disableTools: true,
      ambient: false,
    },
    {
      label: "durable raw run",
      modelRun: true,
      detached: false,
      disableTools: true,
      ambient: true,
    },
    { label: "detached ordinary run", detached: true, disableTools: true, ambient: true },
    {
      label: "detached tool-capable raw run",
      modelRun: true,
      detached: true,
      disableTools: false,
      ambient: true,
    },
  ])("prepares only the required ambient context for $label", async (mode) => {
    const resolveRuntime = vi.spyOn(runtimePrompt, "resolveAgentRuntimePrompt");
    const resolveReferences = vi.spyOn(referencePaths, "resolveOpenClawReferencePaths");
    const config = {};
    const attempt = {
      provider: "openai",
      modelId: "gpt-5.6-luna",
      model: makeProviderModelFixture({
        id: "gpt-5.6-luna",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      }),
      config,
      admittedRunContext: await admitPrompt(config),
      runId: "raw-prompt-run",
      sessionId: "raw-prompt",
      sessionKey: "agent:main:raw-prompt",
      sessionPersistence: mode.detached ? "detached" : "durable",
      modelRun: mode.modelRun,
      promptMode: mode.promptMode,
      disableTools: mode.disableTools,
    } satisfies Parameters<typeof prepareEmbeddedAttemptSystemPrompt>[0]["attempt"];
    const getProviderRuntimeHandle = vi.fn(() => ({
      provider: attempt.provider,
      modelId: attempt.modelId,
      prepared: true as const,
    }));
    const prepared = await prepareEmbeddedAttemptSystemPrompt({
      attempt,
      activeContextEngine: undefined,
      bootstrap: {
        ...buildBootstrapBudgetState({ files: [] }),
        bootstrapMode: "full",
        contextFiles: [],
        bootstrapInjectionStats: [],
        shouldRecordCompletedBootstrapTurn: false,
        workspaceNotes: [],
      },
      setup: createAttemptSetupFixture({ getProviderRuntimeHandle }),
      capabilityToolNames: new Set(),
      effectiveTools: [],
      isRawModelRun: mode.modelRun === true || mode.promptMode === "none",
      modelToolsEnabled: true,
      skillsPrompt: "",
      toolSearchDirectoryEnabled: false,
      toolSearchRuntimeConfig: config,
    });

    if (mode.ambient) {
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
  });

  it.each(["/tmp/open\u202eclaw\n"])(
    "injects workspace identity context from %j",
    async (workspaceDir) => {
      const result = await buildPrompt({
        workspaceDir,
        contextFiles: identityFiles,
      });

      expectText(
        result.systemPrompt,
        ["\nWorking directory: /tmp/openclaw\n", ...identityFiles.map((file) => file.content)],
        ["\u202e"],
      );
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

  it("filters first-turn curated context to global and active-project entries", async () => {
    const result = await buildPrompt({
      activeProjectKeys: ["github.com/acme/Alpha"],
      contextFiles: [
        {
          path: "/tmp/openclaw/MEMORY.md",
          content: [
            "# Durable memory",
            "- Alpha fact. <!-- project: github.com/acme/Alpha -->",
            "- Beta fact. <!-- project: github.com/acme/Beta -->",
            "- Global fact.",
          ].join("\n"),
        },
      ],
    });

    expectText(result.systemPrompt, ["Alpha fact", "Global fact"], ["Beta fact"]);
  });

  it("preserves bootstrap Project Context", async () => {
    const result = await buildPrompt({
      bootstrapMode: "full",
      bootstrapTruncationNotice: "Bootstrap context was truncated.",
      contextFiles: [
        {
          path: "/tmp/openclaw/BOOTSTRAP.md",
          content: "Reply with BOOTSTRAP_OK.",
        },
        ...identityFiles,
      ],
    });

    expectText(result.systemPrompt, [
      "## Bootstrap Pending",
      "Bootstrap context was truncated.",
      ...identityFiles.map((file) => file.content),
      "Reply with BOOTSTRAP_OK.",
    ]);
  });

  it("preserves runtime extra system prompt context", async () => {
    const result = await buildPrompt({
      promptMode: "minimal",
      extraSystemPrompt:
        "# Subagent Context\n\n## Your Role\n- You were created to handle: RUN_MODE_TASK_77950",
      bootstrapMode: "full",
      contextFiles: [],
    });

    expectText(result.systemPrompt, [
      "Current model identity: openai/gpt-5.5.",
      "## Subagent Context",
      "RUN_MODE_TASK_77950",
    ]);
  });
});

describe("embedded session prompt delivery", () => {
  // Provider prefix caches need one system prompt per session; turn delivery rules
  // that differ (heartbeats, completions) travel in the turn's runtime context.
  it.each([
    [
      "source-only completion",
      {
        sourceReplyDeliveryMode: "message_tool_only" as const,
        requireExplicitMessageTarget: false,
      },
    ],
    [
      "explicit-target heartbeat",
      { sourceReplyDeliveryMode: "message_tool_only" as const, requireExplicitMessageTarget: true },
    ],
  ])("keeps the user turn's system prompt on a %s turn", async (_kind, turn) => {
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
      buildTurnDeliveryContextFragments({
        sessionKey: synthetic.attempt.sessionKey,
        sourceReplyDeliveryMode: turn.sourceReplyDeliveryMode,
        requireExplicitMessageTarget: turn.requireExplicitMessageTarget,
      })
        .map((fragment) => fragment.text)
        .join("\n"),
    ).toMatch(
      turn.requireExplicitMessageTarget
        ? /final text is private[\s\S]*target required this turn/u
        : /final text is private/u,
    );
  });
});
