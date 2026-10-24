import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import { loadCliSessionHistoryMessages } from "../cli-runner/session-history.js";
import type { RunCliAgentParams } from "../cli-runner/types.js";
import { SessionManager } from "../sessions/index.js";
import { resolveEmbeddedCliBackendDispatchEligibility } from "./cli-backend-dispatch-eligibility.js";
import { runEmbeddedAgentViaCliBackendIfEligible } from "./cli-backend-dispatch.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const ensureAuthProfileStore = vi.hoisted(() => vi.fn());
const resolveAuthProfileOrder = vi.hoisted(() => vi.fn());
const resolveModelAuthMode = vi.hoisted(() => vi.fn());
const resolveRuntimeCliBackends = vi.hoisted(() => vi.fn());
const resolveCliRuntimeExecutionProvider = vi.hoisted(() => vi.fn());
const runCliAgent = vi.hoisted(() => vi.fn());
const retireSessionMcpRuntime = vi.hoisted(() => vi.fn());
const tempDirs = useSessionStoreTempDirs(afterAll, "cli-dispatch-history-");

// mock-isolation: Dispatch eligibility uses fixture auth modes without host credential discovery.
vi.mock("../model-auth.js", () => ({
  ensureAuthProfileStore,
  ensureAuthProfileStoreAsync: ensureAuthProfileStore,
  resolveAuthProfileOrder,
  resolveModelAuthMode,
}));
vi.mock("../model-runtime-aliases.js", () => ({
  resolveCliRuntimeExecutionProvider,
}));
vi.mock("../../plugins/cli-backends.runtime.js", () => ({
  resolveRuntimeCliBackends,
}));
vi.mock("../cli-runner.runtime.js", () => ({
  runCliAgent,
}));
vi.mock("../agent-bundle-mcp-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-bundle-mcp-tools.js")>()),
  retireSessionMcpRuntime,
}));
const transcriptRecorder = vi.hoisted(() => ({
  noteToolEvent: vi.fn(),
  noteAssistantText: vi.fn(),
  flushAssistantSnapshot: vi.fn(),
  finalize: vi.fn(async () => undefined),
}));
const createCliDispatchTranscriptRecorder = vi.hoisted(() =>
  vi.fn<typeof import("./cli-backend-dispatch-transcript.js").createCliDispatchTranscriptRecorder>(
    () => transcriptRecorder,
  ),
);
vi.mock("./cli-backend-dispatch-transcript.js", () => ({
  createCliDispatchTranscriptRecorder,
}));

type CliDispatchParams = Parameters<typeof runEmbeddedAgentViaCliBackendIfEligible>[0];

function baseRunParams(overrides: Partial<CliDispatchParams> = {}): CliDispatchParams {
  const runId = overrides.runId ?? "run-cli-dispatch-test";
  return {
    admittedRunContext: createTestAdmittedRunContext(runId),
    sessionId: "recall-session",
    sessionKey: "agent:main:recall",
    sessionTarget: {
      agentId: "main",
      sessionId: overrides.sessionId ?? "recall-session",
      sessionKey: overrides.sessionKey ?? "agent:main:recall",
      storePath: "/tmp/recall/openclaw-agent.sqlite",
    },
    sessionFile: "/tmp/recall/session.jsonl",
    workspaceDir: "/tmp/recall/workspace",
    prompt: "recall prompt",
    provider: "claude-cli",
    model: "claude-opus-4-8",
    timeoutMs: 30_000,
    runId,
    cliBackendDispatch: "subscription-auth" as const,
    toolsAllow: ["memory_search"],
    ...overrides,
  };
}

function cliRunResult(meta: Partial<EmbeddedAgentRunResult["meta"]> = {}): EmbeddedAgentRunResult {
  return {
    payloads: [{ text: "recall summary" }],
    meta: meta as EmbeddedAgentRunResult["meta"],
  } as EmbeddedAgentRunResult;
}

const runDispatch = (overrides: Partial<CliDispatchParams> = {}) =>
  runEmbeddedAgentViaCliBackendIfEligible(baseRunParams(overrides));
const profiles = {
  "anthropic:claude-cli": { type: "oauth", provider: "claude-cli" },
  "anthropic:api": { type: "api_key", provider: "anthropic" },
};
const sessionTargetFor = (storePath: string) => ({
  agentId: "main",
  sessionId: "recall-session",
  sessionKey: "agent:main:recall",
  storePath,
});
async function useActualRecorder() {
  const { createCliDispatchTranscriptRecorder: create } = await vi.importActual<
    typeof import("./cli-backend-dispatch-transcript.js")
  >("./cli-backend-dispatch-transcript.js");
  createCliDispatchTranscriptRecorder.mockImplementationOnce(create);
}
function emitTool(runId: string, data: Record<string, unknown>) {
  emitAgentEvent({ runId, stream: "tool", data });
}

beforeEach(() => {
  ensureAuthProfileStore.mockReset();
  resolveAuthProfileOrder.mockReset();
  resolveModelAuthMode.mockReset();
  resolveRuntimeCliBackends.mockReset();
  runCliAgent.mockReset();
  retireSessionMcpRuntime.mockReset();
  resolveCliRuntimeExecutionProvider.mockReset();
  ensureAuthProfileStore.mockReturnValue({ profiles: {} });
  resolveAuthProfileOrder.mockReturnValue([]);
  resolveModelAuthMode.mockReturnValue("oauth");
  resolveRuntimeCliBackends.mockReturnValue([
    { id: "claude-cli", subscriptionAuthDispatch: true },
    { id: "google-gemini-cli" },
  ]);
  resolveCliRuntimeExecutionProvider.mockReturnValue(undefined);
  retireSessionMcpRuntime.mockResolvedValue(true);
  runCliAgent.mockResolvedValue(cliRunResult());
  transcriptRecorder.noteToolEvent.mockReset();
  transcriptRecorder.noteAssistantText.mockReset();
  transcriptRecorder.flushAssistantSnapshot.mockReset();
  transcriptRecorder.finalize.mockClear();
  createCliDispatchTranscriptRecorder.mockClear();
});

describe("resolveEmbeddedCliBackendDispatchEligibility", () => {
  it.each([
    ["anthropic:api", "anthropic:claude-cli", undefined],
    ["anthropic:claude-cli", "anthropic:api", { provider: "claude-cli" }],
    ["anthropic:missing", "anthropic:api", undefined],
  ] as const)("honors pinned %s ahead of ordered %s", (authProfileId, first, expected) => {
    ensureAuthProfileStore.mockReturnValue({ profiles });
    resolveAuthProfileOrder.mockReturnValue([first, authProfileId]);
    expect(
      resolveEmbeddedCliBackendDispatchEligibility({ provider: "claude-cli", authProfileId }),
    ).toEqual(expected);
    expect(resolveModelAuthMode).not.toHaveBeenCalled();
  });

  it("forwards the pinned auth profile into runtime resolution", () => {
    resolveCliRuntimeExecutionProvider.mockReturnValue("claude-cli");
    ensureAuthProfileStore.mockReturnValue({
      profiles: { "anthropic:claude-cli": { type: "oauth", provider: "claude-cli" } },
    });
    expect(
      resolveEmbeddedCliBackendDispatchEligibility({
        provider: "anthropic",
        model: "claude-opus-4-8",
        agentId: "main",
        authProfileId: "anthropic:claude-cli",
      }),
    ).toEqual({ provider: "claude-cli" });
    expect(resolveCliRuntimeExecutionProvider).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: "anthropic:claude-cli" }),
    );
  });
});

describe("runEmbeddedAgentViaCliBackendIfEligible gate", () => {
  it("returns undefined without the opt-in", async () => {
    expect(await runDispatch({ cliBackendDispatch: undefined })).toBeUndefined();
    expect(resolveModelAuthMode).not.toHaveBeenCalled();
    expect(runCliAgent).not.toHaveBeenCalled();
  });

  it("keeps message-tool-only source replies on the embedded delivery owner", async () => {
    expect(
      await runDispatch({
        sourceReplyDeliveryMode: "message_tool_only",
        toolsAllow: ["message"],
        messageChannel: "telegram",
        currentChannelId: "telegram:source-chat",
      }),
    ).toBeUndefined();
    expect(runCliAgent).not.toHaveBeenCalled();
  });

  it("dispatches claude-cli runs with subscription (oauth) credentials", async () => {
    expect(
      await runDispatch({ agentDir: "/agents/main", workspaceDir: "/workspace" }),
    ).toBeDefined();
    expect(ensureAuthProfileStore).toHaveBeenCalledWith("/agents/main", expect.anything());
    expect(resolveModelAuthMode).toHaveBeenCalledWith(
      "claude-cli",
      undefined,
      expect.anything(),
      expect.objectContaining({ workspaceDir: "/workspace" }),
    );
    expect(runCliAgent.mock.calls[0]?.[0]).toMatchObject({ provider: "claude-cli" });
  });

  it("dispatches when no credential mode resolves for the passthrough", async () => {
    resolveModelAuthMode.mockReturnValue(undefined);
    expect(await runDispatch()).toBeDefined();
    expect(runCliAgent).toHaveBeenCalledTimes(1);
  });

  it("dispatches when the credential store is unreadable", async () => {
    ensureAuthProfileStore.mockImplementation(() => {
      throw new Error("store unreadable");
    });
    expect(await runDispatch()).toBeDefined();
    expect(runCliAgent).toHaveBeenCalledTimes(1);
  });

  it.each(["api-key", "mixed", "aws-sdk"] as const)(
    "keeps the passthrough when the auth mode is %s",
    async (mode) => {
      resolveModelAuthMode.mockReturnValue(mode);
      expect(await runDispatch()).toBeUndefined();
      expect(runCliAgent).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["anthropic:claude-cli", "anthropic:api", true],
    ["anthropic:api", "anthropic:claude-cli", false],
  ] as const)("uses ordered profile %s in a mixed store", async (first, second, dispatches) => {
    ensureAuthProfileStore.mockReturnValue({ profiles });
    resolveAuthProfileOrder.mockReturnValue([first, second]);
    resolveModelAuthMode.mockReturnValue("mixed");
    const result = await runDispatch();
    expect(result !== undefined).toBe(dispatches);
    expect(runCliAgent).toHaveBeenCalledTimes(dispatches ? 1 : 0);
    expect(resolveModelAuthMode).not.toHaveBeenCalled();
  });

  it.each([undefined, "raw", "resolved"] as const)(
    "dispatches canonical refs through claude-cli with %s logical route resolution",
    async (requestedRouteResolution) => {
      resolveCliRuntimeExecutionProvider.mockReturnValue("claude-cli");
      expect(
        await runDispatch({
          provider: "anthropic",
          model: "claude-opus-4-8",
          agentId: "main",
          requestedRouteResolution,
        }),
      ).toBeDefined();
      expect(resolveCliRuntimeExecutionProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "anthropic",
          agentId: "main",
          modelId: "claude-opus-4-8",
        }),
      );
      const dispatched = runCliAgent.mock.calls[0]?.[0];
      expect(dispatched).toMatchObject({ provider: "claude-cli" });
      expect(dispatched.requesterModel).toEqual(
        requestedRouteResolution === "resolved"
          ? { provider: "anthropic", model: "claude-opus-4-8" }
          : undefined,
      );
    },
  );

  it("keeps the passthrough for canonical refs without a claude-cli runtime", async () => {
    resolveCliRuntimeExecutionProvider.mockReturnValue(undefined);
    expect(await runDispatch({ provider: "anthropic", model: "claude-opus-4-8" })).toBeUndefined();
    resolveCliRuntimeExecutionProvider.mockReturnValue("google-gemini-cli");
    expect(
      await runDispatch({ provider: "google", model: "gemini-3.1-pro-preview" }),
    ).toBeUndefined();
    expect(runCliAgent).not.toHaveBeenCalled();
  });

  it("keeps the passthrough for other CLI runtimes until verified", async () => {
    expect(await runDispatch({ provider: "google-gemini-cli" })).toBeUndefined();
    expect(resolveModelAuthMode).not.toHaveBeenCalled();
  });

  it("keeps the passthrough without a caller-owned session file", async () => {
    expect(await runDispatch({ sessionFile: undefined })).toBeUndefined();
  });

  it("keeps the passthrough when no claude-cli backend is registered", async () => {
    resolveRuntimeCliBackends.mockReturnValue([]);
    expect(await runDispatch()).toBeUndefined();
  });
});

describe("runEmbeddedAgentViaCliBackendIfEligible execution", () => {
  it("reads and mirrors the dispatched turn in the selected custom SQLite store", async () => {
    setRuntimeConfigSnapshot({});
    onTestFinished(clearRuntimeConfigSnapshot);
    const dir = tempDirs.make();
    const sessionTarget = sessionTargetFor(path.join(dir, "openclaw-agent.sqlite"));
    await upsertSessionEntryCore(sessionTarget, {
      sessionId: sessionTarget.sessionId,
      updatedAt: 1,
    });
    await appendTranscriptMessage(sessionTarget, {
      message: { role: "user", content: "persisted prior context", timestamp: 1 },
      cwd: dir,
    });
    await useActualRecorder();
    runCliAgent.mockImplementationOnce(async (cliParams: RunCliAgentParams) => {
      expect
        .soft(await loadCliSessionHistoryMessages({ sessionTarget: cliParams.sessionTarget }))
        .toEqual(
          expect.arrayContaining([expect.objectContaining({ content: "persisted prior context" })]),
        );
      return cliRunResult();
    });

    await runDispatch({ sessionTarget, workspaceDir: dir });

    expect(loadTranscriptEventsSync(sessionTarget)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({
            role: "user",
            content: [{ type: "text", text: "recall prompt" }],
          }),
        }),
        expect.objectContaining({
          message: expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "recall summary" }],
          }),
        }),
      ]),
    );
  });

  it("maps the embedded run onto a one-shot restricted CLI run", async () => {
    const sessionTarget = sessionTargetFor("/tmp/recall/custom/openclaw-agent.sqlite");
    const params = baseRunParams({
      sessionTarget,
      toolsAllow: ["memory_search", "memory_get", "notes_retrieve_context"],
      fastMode: "auto",
      fastModeStartedAtMs: 1000,
      fastModeAutoOnSeconds: 15,
      authProfileId: "selected-subscription-profile",
    });

    const result = await runEmbeddedAgentViaCliBackendIfEligible(params);

    expect(result?.payloads?.[0]?.text).toBe("recall summary");
    expect(runCliAgent).toHaveBeenCalledTimes(1);
    const cliParams = runCliAgent.mock.calls[0]?.[0];
    expect(cliParams?.sessionTarget).toBe(sessionTarget);
    expect(cliParams).toMatchObject({
      provider: "claude-cli",
      model: "claude-opus-4-8",
      sessionFile: "/tmp/recall/session.jsonl",
      timeoutMs: 30_000,
      runTimeoutOverrideMs: 30_000,
      fastMode: "auto",
      fastModeStartedAtMs: 1000,
      fastModeAutoOnSeconds: 15,
      authProfileId: "selected-subscription-profile",
      disableCliLiveSession: true,
      cleanupCliLiveSessionOnRunEnd: true,
      requireExplicitMessageTarget: true,
      cliToolAvailability: {
        native: [],
        openClaw: ["memory_search", "memory_get", "notes_retrieve_context"],
      },
    });
    // Embedded toolsAllow must never reach the CLI runner: it fails closed.
    expect(cliParams).not.toHaveProperty("toolsAllow");
  });

  it("forwards authoritative group type through embedded-to-CLI dispatch for opaque keys", async () => {
    const chatType = "group";
    await runEmbeddedAgentViaCliBackendIfEligible(
      baseRunParams({
        sessionKey: "agent:main:opaque:binding",
        chatType,
      }),
    );

    expect(runCliAgent.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: "agent:main:opaque:binding",
      chatType,
    });
  });

  // Fail-closed tool policy: only a non-empty named allowlist is expressible
  // on the CLI surface. Every other embedded tool state keeps the passthrough
  // so no closed state silently widens.
  it.each([
    ["a mixed wildcard allowlist", { toolsAllow: ["memory_search", "*"] }],
    ["a deny-all allowlist", { toolsAllow: [] }],
    ["no allowlist", { toolsAllow: undefined }],
    ["disableTools", { disableTools: true }],
    ["a raw model run", { modelRun: true }],
  ] as const)("refuses dispatch for %s", async (_label, overrides) => {
    expect(await runDispatch(overrides as Partial<CliDispatchParams>)).toBeUndefined();
    expect(runCliAgent).not.toHaveBeenCalled();
  });

  it("settles execution-start work before dispatching the CLI run", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const onExecutionStarted = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    const operation = runDispatch({ onExecutionStarted, lifecycleGeneration: "gen-1" });
    try {
      await entered.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(runCliAgent).not.toHaveBeenCalled();
      expect(transcriptRecorder.finalize).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await operation;
    }
    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(onExecutionStarted).toHaveBeenCalledOnce();
    expect(onExecutionStarted).toHaveBeenCalledWith({ lifecycleGeneration: "gen-1" });
  });

  it("finalizes the transcript when execution-start work rejects", async () => {
    const failure = new Error("execution-start persistence failed");
    await expect(
      runDispatch({
        onExecutionStarted: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(runCliAgent).not.toHaveBeenCalled();
    expect(transcriptRecorder.finalize).toHaveBeenCalledOnce();
  });

  it("retains the prepared vision capability with ordered prompt images and media", async () => {
    const images = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];
    const imageOrder = ["inline" as const];
    const media = [{ path: "/tmp/recall.png", contentType: "image/png" }];

    await runEmbeddedAgentViaCliBackendIfEligible(
      baseRunParams({ modelHasVision: true, images, imageOrder, media }),
    );

    expect(runCliAgent.mock.calls[0]?.[0]).toMatchObject({
      prompt: "recall prompt",
      modelHasVision: true,
      images,
      imageOrder,
      media,
    });
  });

  it("forwards execution phases from the CLI backend", async () => {
    const onExecutionPhase = vi.fn();
    runCliAgent.mockImplementation(
      async (cliParams: { onExecutionPhase?: CliDispatchParams["onExecutionPhase"] }) => {
        cliParams.onExecutionPhase?.({
          phase: "model_call_started",
          provider: "anthropic",
          model: "claude-opus-4-8",
          backend: "claude-cli",
          firstModelCallStarted: true,
        });
        return cliRunResult();
      },
    );

    await runEmbeddedAgentViaCliBackendIfEligible(baseRunParams({ onExecutionPhase }));

    expect(onExecutionPhase).toHaveBeenCalledWith({
      phase: "model_call_started",
      provider: "anthropic",
      model: "claude-opus-4-8",
      backend: "claude-cli",
      firstModelCallStarted: true,
    });
  });

  it("bridges CLI tool result events to onAgentToolResult without the MCP prefix", async () => {
    const observed: Array<{ toolName: string; isError: boolean }> = [];
    const params = baseRunParams({
      toolsAllow: ["memory_search"],
      onAgentToolResult: (event) => {
        observed.push({ toolName: event.toolName, isError: event.isError });
      },
    });
    runCliAgent.mockImplementation(async (cliParams: { runId: string }) => {
      emitTool(cliParams.runId, {
        phase: "result",
        name: "mcp__openclaw__memory_search",
        result: { content: [] },
        isError: false,
        resultContentSource: "network",
      });
      // Soft tool failures must surface as isError like the native path.
      emitTool(cliParams.runId, {
        phase: "result",
        name: "mcp__openclaw__memory_get",
        result: { details: { status: "error" } },
        isError: false,
      });
      emitTool("other-run", { phase: "result", name: "mcp__openclaw__memory_get", isError: true });
      return cliRunResult();
    });

    await runEmbeddedAgentViaCliBackendIfEligible(params);

    expect(observed).toEqual([
      { toolName: "memory_search", isError: false },
      { toolName: "memory_get", isError: true },
    ]);

    // The bridge must not outlive the run.
    emitTool(params.runId, {
      phase: "result",
      name: "mcp__openclaw__memory_search",
      isError: false,
    });
    expect(observed).toHaveLength(2);
  });

  it("delegates MCP lifetime policy to the CLI settlement owner", async () => {
    const cleanupBundleMcpOnRunEnd = true;
    await runEmbeddedAgentViaCliBackendIfEligible(baseRunParams({ cleanupBundleMcpOnRunEnd }));
    expect(runCliAgent.mock.calls[0]?.[0]?.cleanupBundleMcpOnRunEnd).toBe(cleanupBundleMcpOnRunEnd);
    expect(retireSessionMcpRuntime).not.toHaveBeenCalled();
  });

  it("mirrors the run into the transcript recorder", async () => {
    runCliAgent.mockImplementation(async (cliParams: { runId: string }) => {
      emitAgentEvent({
        runId: cliParams.runId,
        stream: "assistant",
        data: { text: "partial answer" },
      });
      emitTool(cliParams.runId, {
        phase: "start",
        name: "mcp__openclaw__memory_search",
        toolCallId: "call-1",
        args: { query: "wings" },
      });
      emitTool(cliParams.runId, {
        phase: "result",
        name: "mcp__openclaw__memory_search",
        toolCallId: "call-1",
        result: { content: [] },
        isError: false,
        resultContentSource: "network",
      });
      return cliRunResult();
    });

    await runDispatch({ toolsAllow: ["memory_search"] });

    expect(createCliDispatchTranscriptRecorder).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile: "/tmp/recall/session.jsonl",
        sessionId: "recall-session",
        prompt: "recall prompt",
        provider: "claude-cli",
      }),
    );
    expect(transcriptRecorder.noteAssistantText).toHaveBeenCalledWith("partial answer");
    expect(transcriptRecorder.noteToolEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "start",
        toolName: "memory_search",
        toolCallId: "call-1",
        args: { query: "wings" },
      }),
    );
    expect(transcriptRecorder.noteToolEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "result",
        toolName: "memory_search",
        resultContentSource: "network",
      }),
    );
    expect(transcriptRecorder.finalize).toHaveBeenCalledWith("recall summary");
  });

  it("flushes the assistant snapshot the moment the run aborts", async () => {
    const abortController = new AbortController();
    runCliAgent.mockImplementation(async () => {
      abortController.abort(new Error("recall timeout"));
      expect(transcriptRecorder.flushAssistantSnapshot).toHaveBeenCalledTimes(1);
      throw new Error("aborted");
    });
    await expect(runDispatch({ abortSignal: abortController.signal })).rejects.toThrow("aborted");
    expect(transcriptRecorder.finalize).toHaveBeenCalledWith(undefined);
  });

  it("drops CLI session bindings from the run result", async () => {
    runCliAgent.mockResolvedValue(
      cliRunResult({
        agentMeta: {
          sessionId: "native-session",
          cliSessionBinding: { sessionId: "native-session" },
        },
      } as Partial<EmbeddedAgentRunResult["meta"]>),
    );
    const result = await runDispatch();
    expect(result?.meta.agentMeta?.cliSessionBinding).toBeUndefined();
  });
});

describe("detached CLI transcript ownership", () => {
  it.each([false, true])(
    "does not mirror a detached turn into durable metadata (existing: %s)",
    async (existing) => {
      const root = tempDirs.make();
      const storePath = path.join(root, "final", "openclaw-agent.sqlite");
      const params = baseRunParams({
        agentId: "main",
        sessionPersistence: "detached",
        sessionManager: SessionManager.inMemory(root),
        sessionTarget: sessionTargetFor(storePath),
      });
      if (existing) {
        await upsertSessionEntryCore(params.sessionTarget, {
          sessionId: params.sessionId,
          updatedAt: 1,
          liveModelSwitchPending: true,
        });
      }
      const before = loadSessionEntryReadOnly(params.sessionTarget);
      await useActualRecorder();
      await expect(runEmbeddedAgentViaCliBackendIfEligible(params)).resolves.toMatchObject({
        payloads: [{ text: "recall summary" }],
      });
      expect(runCliAgent).toHaveBeenCalledOnce();
      expect(loadSessionEntryReadOnly(params.sessionTarget)).toEqual(before);
      if (!existing) {
        await expect(fs.access(path.dirname(storePath))).rejects.toThrow();
      } else {
        expect(loadTranscriptEventsSync(params.sessionTarget)).toEqual([]);
      }
    },
  );
});
