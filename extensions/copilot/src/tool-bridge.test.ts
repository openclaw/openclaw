import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createOpenClawCodingTools as createRealOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import {
  type AnyAgentTool,
  type SandboxContext,
  finalizeToolTerminalPresentation,
  runAgentHarnessAfterToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createContractToolTerminalObserver,
  createOwnerBackedContractTool,
  createTerminalPresentationContractTool,
  setHostToolFactoryForTest,
  textToolResult,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { readMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCopilotTestHostCapabilities } from "./host-capability.test-support.js";
import {
  convertOpenClawToolToSdkToolForTest as toSdk,
  createCopilotToolBridge as createBridge,
  makeInvocation,
  runSdkTool as invoke,
  type CopilotCodingToolsOptions,
} from "./tool-bridge.test-support.js";

type FakeTool = AnyAgentTool & {
  execute: ReturnType<typeof vi.fn>;
  prepareArguments?: ReturnType<typeof vi.fn>;
};
type BridgeInput = Parameters<typeof createBridge>[0];
type Bridge = Awaited<ReturnType<typeof createBridge>>;
type Attempt = NonNullable<BridgeInput["attemptParams"]>;

function bridgeWithTools(tools: AnyAgentTool[], attemptParams: Attempt, input: BridgeInput = {}) {
  return createBridge({ ...input, attemptParams, createOpenClawCodingTools: () => tools });
}

function run(bridge: Bridge, name: string, args: unknown = {}) {
  return invoke(sdkToolNamed(bridge, name), args);
}

function flushAsync() {
  return Promise.resolve().then(() => {});
}

function makeTool(
  overrides: Partial<FakeTool> = {},
  result: { content?: unknown; details: unknown } = {
    content: [{ text: "done", type: "text" }],
    details: null,
  },
): FakeTool {
  return {
    description: "A fake tool",
    execute: vi.fn(async () => result),
    label: "Fake Tool",
    name: "tool-a",
    parameters: { type: "object" } as never,
    ...overrides,
  } as unknown as FakeTool;
}

function makeTools(...names: string[]) {
  return names.map((name) => makeTool({ name }));
}

async function captureOptions(input: BridgeInput, tools = [makeTool()]) {
  const createOpenClawCodingTools = vi.fn((_options?: CopilotCodingToolsOptions) => tools);
  await createBridge({ ...input, createOpenClawCodingTools });
  return expectDefined(createOpenClawCodingTools.mock.calls[0]?.[0], "tool options");
}

function sdkToolNamed(bridge: Bridge, name: string) {
  const tool = bridge.promptToolPolicy.apply().tools.find((candidate) => candidate.name === name);
  return expectDefined(tool, name);
}

function createTerminalTracker(runId: string) {
  const observer = createContractToolTerminalObserver(runId);
  let lastToolError: ReturnType<typeof observer>["lastToolError"];
  return {
    observeToolTerminal: (observation: Parameters<typeof observer>[0]) => {
      const resolution = observer(observation);
      lastToolError = resolution.lastToolError;
      return resolution;
    },
    lastError: () => lastToolError,
  };
}

const memoryArgs = { memoryId: "9e107d9d-3729-4ff5-a8c0-01d29c61f49d" };
const directConfig = { tools: { toolSearch: false } };
const searchAttempt = {
  config: { tools: { toolSearch: true } },
  runId: "run-tool-search",
  sessionKey: "agent:agent-1:main",
};
function memoryTool() {
  return createOwnerBackedContractTool({
    pluginId: "memory-lancedb",
    name: "memory_forget",
    result: textToolResult("unused"),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("createCopilotToolBridge", () => {
  it.each([
    "formatter",
    "plain",
    "structured-error",
    "observer-error",
    "source-error",
    "aborted-outcome",
  ] as const)("finalizes direct SDK terminal presentation (%s)", async (kind) => {
    const runId = "direct-terminal-" + kind;
    const sessionId = "session-" + runId;
    const sessionKey = "agent:main:" + runId;
    const toolCallId = "call-" + kind;
    const toolName = "fixture_direct";
    const failure = new Error("terminal fixture failed");
    const result = textToolResult(
      "Fixture completed",
      kind === "structured-error" ? { status: "error", error: failure.message } : {},
    );
    const config = { tools: { codeMode: false, toolSearch: false } } as const;
    const controller = new AbortController();
    const onToolOutcome = vi.fn<NonNullable<Attempt["onToolOutcome"]>>((outcome) => {
      if (kind === "aborted-outcome" && !outcome.presentationOnly) {
        controller.abort(failure);
      }
    });
    const host = await createAdmittedHostCapabilityTestFixture({
      agentId: "main",
      runId,
      sessionId,
      sessionKey,
      config,
      onToolOutcome,
      allocateToolOutcomeOrdinal: () => 7,
      abortSignal: controller.signal,
    });
    const source =
      kind === "plain"
        ? makeTool({ name: toolName }, result)
        : createTerminalPresentationContractTool({
            name: toolName,
            result,
            format: () => "Fixture completed",
          });
    if (kind === "source-error") {
      source.execute = async () => {
        throw failure;
      };
    }
    const terminalObserver = createContractToolTerminalObserver(runId);
    const completed = createDeferred<void>();
    let bridge: Bridge | undefined;
    let sdkResult: unknown;
    let rejected: unknown;
    let beforeCleanup: Parameters<NonNullable<Attempt["onToolOutcome"]>>[0][];
    let afterCleanupCount: number;
    try {
      // Only construction is substituted; the admitted host installs the real wrapper.
      await setHostToolFactoryForTest({ runId }, () => [source]);
      bridge = await createBridge({
        agentId: "main",
        sessionId,
        attemptParams: {
          config,
          runId,
          sessionKey,
          onToolOutcome,
          abortSignal: controller.signal,
          observeToolTerminal: (observation) => {
            if (kind === "observer-error") {
              throw failure;
            }
            return terminalObserver(observation);
          },
          hostCapabilities: host.hostCapabilities,
        },
        onToolCompleted: async (completion) => {
          try {
            await runAgentHarnessAfterToolCallHook({
              ...completion,
              runId,
              sessionId,
              sessionKey,
              startArgs: completion.args,
            });
          } finally {
            completed.resolve();
          }
        },
      });
      try {
        sdkResult = await invoke(
          sdkToolNamed(bridge, toolName),
          { label: kind },
          makeInvocation({ toolCallId, toolName, sessionId }),
        );
        await completed.promise;
      } catch (error) {
        rejected = error;
      }
    } finally {
      // Record all phases before asserting, including the exact-ID late-finalizer check.
      beforeCleanup = onToolOutcome.mock.calls.map(([outcome]) => outcome);
      bridge?.cleanup?.();
      host.closeHost();
      host.closeAdmission();
      afterCleanupCount = onToolOutcome.mock.calls.length;
      finalizeToolTerminalPresentation({ toolCallId, runId, result, isError: false });
    }
    const published = kind !== "source-error" && kind !== "aborted-outcome";
    const successful = kind === "formatter" || kind === "plain";
    if (kind === "observer-error") {
      expect(rejected).toBe(failure);
    } else {
      expect(rejected).toBeUndefined();
      expect(sdkResult).toMatchObject({ resultType: successful ? "success" : "failure" });
    }
    expect(beforeCleanup.filter((outcome) => !outcome.presentationOnly)).toHaveLength(1);
    expect(beforeCleanup.filter((outcome) => outcome.presentationOnly)).toEqual(
      published
        ? [
            expect.objectContaining({
              toolName,
              toolCallOrdinal: 7,
              terminalPresentation: kind === "formatter" ? "Fixture completed" : undefined,
            }),
          ]
        : [],
    );
    expect(afterCleanupCount).toBe(beforeCleanup.length);
    expect(onToolOutcome).toHaveBeenCalledTimes(afterCleanupCount);
  });

  it("returns empty arrays for unsupported providers without calling the seam", async () => {
    const createOpenClawCodingTools = vi.fn(() => [makeTool()]);

    const result = await createBridge({ createOpenClawCodingTools, modelProvider: "openai" });

    expect(result.codeModeEngaged).toBe(false);
    expect(result.promptToolPolicy.apply()).toEqual({ tools: [], callableToolNames: [] });
    expect(result.sourceTools).toEqual([]);
    expect(createOpenClawCodingTools).toHaveBeenCalledTimes(0);
  });

  it("filters the hidden tool_search catalog before compacting narrowed tools", async () => {
    const opts = await captureOptions(
      { attemptParams: { ...searchAttempt, toolsAllow: ["read"] } },
      makeTools("tool_search", "read", "edit", "write"),
    );
    expect(opts.toolSearchCatalogRef?.current?.entries?.map((entry) => entry.name)).toEqual([
      "read",
    ]);
  });

  it("binds retained code-mode source and SDK controls exactly once", async () => {
    let active = true;
    const cwd = "/tmp/copilot-code-mode-cwd";
    const hiddenExecute = vi.fn(async () => ({ content: [], details: {} }));
    const bindToolSurface = vi.fn((tools: AnyAgentTool[], _options?: Readonly<{ cwd?: string }>) =>
      tools.map((tool) => ({
        ...tool,
        execute: async (...args: Parameters<NonNullable<AnyAgentTool["execute"]>>) => {
          if (!active) {
            throw new Error("agent harness host capability is no longer active");
          }
          return await tool.execute(...args);
        },
      })),
    );
    const bridge = await createBridge({
      cwd,
      attemptParams: {
        config: { tools: { codeMode: true } },
        hostCapabilities: createCopilotTestHostCapabilities(
          () => [makeTool({ execute: hiddenExecute, name: "read" })],
          bindToolSurface,
        ),
        runId: "run-code-mode-bound",
        sessionKey: "agent:agent-1:main",
      },
      modelId: "gpt-test",
    });
    const source = expectDefined(
      bridge.sourceTools.find((tool) => tool.name === "exec"),
      "bound code-mode source control",
    );
    const copiedSourceExecute = source.execute;
    const copiedSdkHandler = sdkToolNamed(bridge, "exec").handler;
    active = false;

    await expect(copiedSourceExecute?.("call-1", { code: "return 1" })).rejects.toThrow(
      "no longer active",
    );
    const rejected = await copiedSdkHandler?.({ code: "return 1" }, makeInvocation());
    expect(rejected).toMatchObject({
      resultType: "failure",
      textResultForLlm: expect.stringContaining("no longer active"),
    });
    expect(
      bindToolSurface.mock.calls.map(([tools, options]) => [
        tools.map((tool) => tool.name),
        options,
      ]),
    ).toEqual([
      [["read"], { cwd }],
      [["exec", "wait"], { cwd }],
    ]);
    expect(hiddenExecute).not.toHaveBeenCalled();
  });

  it("throws on duplicate tool names and lists all duplicates", async () => {
    await expect(
      bridgeWithTools(makeTools("alpha", "beta", "alpha", "beta"), {
        config: directConfig,
        toolsAllow: ["alpha", "beta"],
      }),
    ).rejects.toThrow("duplicate tool names: alpha, beta");
  });

  it("quarantines owner memory writes, edits, and patches after a network tool", async () => {
    await withTempDir("openclaw-copilot-memory-", async (workspaceDir) => {
      await fs.mkdir(path.join(workspaceDir, "memory"));
      let turnTainted = false;
      const onToolOutcome = vi.fn<NonNullable<Attempt["onToolOutcome"]>>((outcome) => {
        if (!outcome.presentationOnly && outcome.resultContentSource === "network") {
          turnTainted = true;
        }
      });
      const createTools = (options: CopilotCodingToolsOptions = {}) => [
        ...createRealOpenClawCodingTools(options).filter((tool) =>
          ["write", "edit", "apply_patch"].includes(tool.name),
        ),
        wrapToolWithBeforeToolCallHook(
          makeTool({ name: "web_fetch", resultContentSource: "network" }),
          {
            agentId: "main",
            sessionKey: options.sessionKey,
            sessionId: options.sessionId,
            runId: options.runId,
            onToolOutcome: options.onToolOutcome,
          },
          { emitDiagnostics: false },
        ),
      ];
      const createMemoryBridge = (sessionId: string, isTurnTainted: () => boolean) =>
        createBridge({
          agentId: "main",
          sessionId,
          workspaceDir,
          attemptParams: {
            config: { tools: { fs: { workspaceOnly: true }, toolSearch: false } },
            onToolOutcome,
            isTurnTainted,
            runId: sessionId,
            senderIsOwner: true,
            sessionKey: `agent:main:${sessionId}`,
            workspaceDir,
          },
          createOpenClawCodingTools: createTools,
        });
      const bridge = await createMemoryBridge("copilot-memory-session", () => turnTainted);
      await run(bridge, "write", { path: "memory/trusted.md", content: "owner note\n" });
      await run(bridge, "web_fetch");
      expect(onToolOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: "web_fetch", resultContentSource: "network" }),
      );
      expect(turnTainted).toBe(true);

      await run(bridge, "write", { path: "memory/network.md", content: "network note\n" });
      await run(bridge, "edit", {
        path: "memory/trusted.md",
        edits: [{ oldText: "owner note", newText: "network edit" }],
      });
      await run(bridge, "apply_patch", {
        input: "*** Begin Patch\n*** Add File: memory/patched.md\n+network patch\n*** End Patch",
      });

      const freshBridge = await createMemoryBridge("copilot-fresh-session", () => false);
      await run(freshBridge, "write", { path: "memory/fresh.md", content: "fresh owner note\n" });

      const provenance = (relativePath: string) =>
        readMemoryArtifactProvenance({ workspaceDir, relativePath: `memory/${relativePath}.md` });
      for (const name of ["trusted", "network", "patched"]) {
        await expect(provenance(name)).resolves.toMatchObject({ originClass: "untrusted" });
      }
      await expect(provenance("fresh")).resolves.toMatchObject({ originClass: "agent" });
      const read = (name: string) =>
        fs.readFile(path.join(workspaceDir, `memory/${name}.md`), "utf8");
      await expect(read("trusted")).resolves.toBe("network edit\n");
      await expect(read("patched")).resolves.toBe("network patch\n");
    });
  });

  it("uses the model read context with prepared model capabilities", async () => {
    const opts = await captureOptions({
      attemptParams: {
        modelId: "configured-alias",
        model: {
          provider: "openai",
          id: "gpt-5.6-sol",
          api: "openai-responses",
          contextWindow: 200_000,
          input: ["text", "image"],
          compat: { some: "shape" },
        },
      } as never,
    });
    expect(opts).toMatchObject({
      modelApi: "openai-responses",
      modelContextWindowTokens: 200_000,
      modelHasVision: true,
    });
    expect(opts.modelCompat).toEqual({ some: "shape" });
    expect(opts.requesterModel).toEqual({ provider: "openai", model: "gpt-5.6-sol" });
  });

  it("onYield still aborts the live session when onYieldDetected throws (defense in depth)", async () => {
    const abort = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const opts = await captureOptions({
      onYieldDetected: () => {
        throw new Error("handler boom");
      },
      sessionRef: { current: { abort } },
    });

    const onYield = expectDefined(opts.onYield, "yield callback");
    expect(() => onYield("handler-fails-but-abort-must-fire")).not.toThrow();
    expect(abort).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("forwards an explicit sandbox and spawnWorkspaceDir verbatim to createOpenClawCodingTools", async () => {
    const sandbox = {
      enabled: true,
      workspaceAccess: "ro",
      workspaceDir: "/sandbox/copy",
    } as unknown as SandboxContext;
    const opts = await captureOptions({
      sandbox,
      sessionKey: "session-1",
      spawnWorkspaceDir: "/original-workspace",
      workspaceDir: "/sandbox/copy",
    });
    expect(opts.sandbox).toBe(sandbox);
    expect(opts).toMatchObject({
      workspaceDir: "/sandbox/copy",
      spawnWorkspaceDir: "/original-workspace",
    });
  });

  it("submits the exact conversation-policy-filtered catalog to the SDK", async () => {
    await withTempDir("openclaw-copilot-policy-", async (workspaceDir) => {
      const result = await createBridge({
        attemptParams: {
          config: {},
          conversationToolPolicy: { deny: ["exec", "process", "write", "edit", "ask_user"] },
          runId: "policy-run",
          sessionKey: "agent:agent-1:policy-session",
          workspaceDir,
        } as never,
        createOpenClawCodingTools: createRealOpenClawCodingTools,
        sessionId: "policy-session",
        sessionKey: "agent:agent-1:policy-session",
        workspaceDir,
      });
      const names = result.promptToolPolicy.apply().tools.map((tool) => tool.name);

      expect(names).toEqual(expect.arrayContaining(["read", "apply_patch"]));
      for (const denied of ["exec", "process", "write", "edit", "ask_user"]) {
        expect(names).not.toContain(denied);
      }
    });
  });

  it("hands question tools this run's prompt delivery callback", async () => {
    const onToolResult = vi.fn();
    const opts = await captureOptions(
      { attemptParams: { messageChannel: "telegram", onToolResult } },
      [],
    );
    expect(opts.questionPrompt).toEqual({ send: onToolResult, messageChannel: "telegram" });
  });

  it("enforces the retained sandbox owner's write deny before SDK tool execution", async () => {
    await withTempDir("openclaw-copilot-policy-owner-", async (workspaceDir) => {
      for (const sandboxAgentId of ["marketing", "main"]) {
        const sessionKey = "agent:marketing:policy-owner-test";
        const bridge = await createBridge({
          agentId: "marketing",
          attemptParams: {
            config: {
              agents: { entries: { main: { tools: { deny: ["write"] } }, marketing: {} } },
              tools: { codeMode: false, toolSearch: false },
            },
            sandboxAgentId,
            sandboxSessionKey: "global",
            sessionKey,
            runId: `policy-owner-${sandboxAgentId}`,
            workspaceDir,
          },
          createOpenClawCodingTools: createRealOpenClawCodingTools,
          sessionKey,
          workspaceDir,
        });
        try {
          const write = bridge.promptToolPolicy.apply().tools.find((tool) => tool.name === "write");
          if (write) {
            const outputPath = path.join(workspaceDir, `${sandboxAgentId}.txt`);
            await expect(
              invoke(write, { path: outputPath, content: "retained policy proof" }),
            ).resolves.toMatchObject({ resultType: "success" });
            await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("retained policy proof");
          }
          expect(await fs.readdir(workspaceDir)).toEqual(["marketing.txt"]);
          expect(write === undefined).toBe(sandboxAgentId === "main");
        } finally {
          bridge.cleanup?.();
        }
      }
    });
  });

  it("does NOT force a message tool when disableMessageTool is true (disable wins over force)", async () => {
    const result = await bridgeWithTools(makeTools("read", "message"), {
      config: directConfig,
      toolsAllow: ["read"],
      forceMessageTool: true,
      disableMessageTool: true,
    });
    expect(result.sourceTools.map((tool) => tool.name)).toEqual(["read"]);
  });
});

describe("createCopilotToolBridge tool conversion", () => {
  it("returns a failure result when prepareArguments throws", async () => {
    const error = new Error("bad args");
    const sourceTool = makeTool({
      prepareArguments: vi.fn(() => {
        throw error;
      }),
    });
    const sdkTool = await toSdk(sourceTool, {});

    const result = await invoke(sdkTool, {});

    expect(sourceTool.execute).toHaveBeenCalledTimes(0);
    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm: "[copilot-tool-bridge] prepareArguments failed for tool 'tool-a': bad args",
      error: error.message,
    });
  });

  it.each([true, false])(
    "attributes failed memory tools by ownership (%s) and clears recovery",
    async (owned) => {
      const tool = owned ? memoryTool() : makeTool({ name: "memory_forget" });
      const message = owned ? "memory delete failed" : "third-party failure";
      const onToolCompleted = vi.fn();
      tool.execute = vi
        .fn()
        .mockRejectedValueOnce(new Error(message))
        .mockResolvedValueOnce(textToolResult("Memory forgotten.", { action: "deleted" }));
      const terminal = createTerminalTracker("run-copilot-forget");
      const sdkTool = await toSdk(tool, { ...terminal, onToolCompleted });
      const forget = (toolCallId: string) =>
        invoke(sdkTool, memoryArgs, makeInvocation({ toolCallId, toolName: "memory_forget" }));
      const result = await forget("forget-1");
      expect(terminal.lastError()).toMatchObject({ mutatingAction: owned });
      if (!owned) {
        expect(terminal.lastError()).not.toHaveProperty("ownerKey");
      }
      expect(onToolCompleted).toHaveBeenCalledWith(
        expect.objectContaining({
          args: memoryArgs,
          error: message,
          toolCallId: "forget-1",
          toolName: "memory_forget",
        }),
      );
      expect(result).toMatchObject({ resultType: "failure", error: message });
      expect(JSON.stringify(result)).not.toContain("memory-lancedb");

      await forget("forget-2");
      expect(terminal.lastError()).toBeUndefined();
    },
  );

  it("reports returned OpenClaw error results to both tool observers", async () => {
    const onAgentToolResult = vi.fn();
    const onToolCompleted = vi.fn();
    const sourceResult = {
      content: [{ text: '{"status":"error","error":"backend unavailable"}', type: "text" }],
      details: { status: "error", error: "backend unavailable" },
    };
    const sdkTool = await toSdk(makeTool({}, sourceResult), { onAgentToolResult, onToolCompleted });

    const result = await invoke(sdkTool, {});
    await flushAsync();

    expect(result).toMatchObject({ resultType: "failure" });
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "tool-a",
      result: sourceResult,
      isError: true,
    });
    expect(onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ error: "backend unavailable", result: sourceResult }),
    );
  });

  it("reports owner-backed catalog tool failures to the host terminal observer", async () => {
    const observeToolTerminal = vi.fn(createContractToolTerminalObserver(searchAttempt.runId));
    const opts = await captureOptions(
      { attemptParams: { ...searchAttempt, observeToolTerminal } },
      makeTools("tool_search"),
    );
    const target = memoryTool();
    const error = new Error("catalog delete failed");
    target.execute = vi.fn().mockRejectedValue(error);
    const executeCatalog = expectDefined(
      opts.toolSearchCatalogExecutor,
      "Copilot catalog executor",
    );
    const pending = executeCatalog({
      tool: target,
      toolName: "memory_forget",
      source: "openclaw",
      sourceName: "memory-lancedb",
      toolCallId: "catalog-forget-1",
      parentToolCallId: "tool-search-1",
      input: memoryArgs,
      acceptResultBeforeProjection: async (result) => result,
    });
    await expect(pending).rejects.toThrow("catalog delete failed");

    expect(observeToolTerminal).toHaveBeenCalledWith({
      toolCallId: "catalog-forget-1",
      toolName: "memory_forget",
      result: error,
      arguments: memoryArgs,
      executionStarted: true,
      outcome: "failure",
      failure: { error: "catalog delete failed" },
      ownerMutation: { ownerKey: '["memory-lancedb","memory_forget"]' },
    });
  });

  it("drains earlier calls after rejection and resumes parallel work after an exclusive call", async () => {
    const started = Array.from({ length: 5 }, () => createDeferred<void>());
    const gates = Array.from({ length: 5 }, () => createDeferred<void>());
    const events: number[] = [];
    const failure = new Error("terminal observer failed");
    const observeTerminal = createContractToolTerminalObserver("copilot-ordering-run");
    const bridge = await bridgeWithTools(
      gates.map((gate, index) =>
        makeTool({
          name: `ordered_${index}`,
          executionMode: index === 2 ? "sequential" : undefined,
          execute: vi.fn(async () => {
            events.push(index);
            expectDefined(started[index], "tool start").resolve();
            await gate.promise;
            return textToolResult(String(index));
          }),
        }),
      ),
      {
        config: directConfig,
        observeToolTerminal: (observation) => {
          if (observation.toolCallId === "call-0") {
            throw failure;
          }
          return observeTerminal(observation);
        },
      },
    );
    const runs = bridge.promptToolPolicy
      .apply()
      .tools.map((tool, index) =>
        invoke(tool, {}, makeInvocation({ toolCallId: `call-${index}` })),
      );
    const settled = Promise.allSettled(runs);
    try {
      await Promise.all([started[0]?.promise, started[1]?.promise]);
      await flushAsync();
      expect([...events]).toEqual([0, 1]);
      gates[0]?.resolve();
      await expect(runs[0]).rejects.toBe(failure);
      await flushAsync();
      expect([...events]).toEqual([0, 1]);
      gates[1]?.resolve();
      await started[2]?.promise;
      await flushAsync();
      expect([...events]).toEqual([0, 1, 2]);
      gates[2]?.resolve();
      await Promise.all([started[3]?.promise, started[4]?.promise]);
      expect([...events]).toEqual([0, 1, 2, 3, 4]);
    } finally {
      for (const gate of gates) {
        gate.resolve();
      }
      await settled;
      bridge.cleanup?.();
    }
    await expect(Promise.all(runs.slice(1))).resolves.toEqual(
      [1, 2, 3, 4].map((index) => ({ resultType: "success", textResultForLlm: String(index) })),
    );
  });

  it("seals one-shot tool admission and joins calls already accepted", async () => {
    const entered = createDeferred<void>();
    const finish = createDeferred<void>();
    const bridge = await bridgeWithTools(
      [
        makeTool({
          name: "pending",
          execute: vi.fn(async () => {
            entered.resolve();
            await finish.promise;
            return textToolResult("done");
          }),
        }),
      ],
      { config: directConfig },
    );
    const pending = run(bridge, "pending");
    await entered.promise;
    let settled = false;
    const cleanup = bridge.settle?.().then(() => {
      settled = true;
    });
    try {
      await expect(run(bridge, "pending")).rejects.toThrow("attempt is closing");
      expect(settled).toBe(false);
    } finally {
      finish.resolve();
      await pending;
      await cleanup;
      bridge.cleanup?.();
    }
    expect(settled).toBe(true);
  });

  it("runs SDK-dispatched tools in the attempt's async context, not the pooled connection's", async () => {
    const turn = new AsyncLocalStorage<string>();
    let seen: string | undefined;
    const bridge = await turn.run("turn-2", () =>
      bridgeWithTools(
        [
          makeTool({
            name: "probe",
            execute: vi.fn(async () => {
              seen = turn.getStore();
              return { content: [], details: {} };
            }),
          }),
        ],
        { config: { tools: { codeMode: false, toolSearch: false } } },
      ),
    );
    try {
      // The pooled SDK connection was opened during turn 1 and dispatches from there.
      await turn.run("turn-1", () => run(bridge, "probe"));
      expect(seen).toBe("turn-2");
    } finally {
      bridge.cleanup?.();
    }
  });

  it("rechecks abort before a queued tool starts without blocking another attempt", async () => {
    const controller = new AbortController();
    const started = createDeferred<void>();
    const gate = createDeferred<void>();
    const queuedExecute = vi.fn(async () => ({ content: [], details: {} }));
    const makeBridge = (sessionId: string, abortSignal?: AbortSignal) =>
      bridgeWithTools(
        [
          makeTool({
            name: "exclusive",
            executionMode: "sequential",
            execute: vi.fn(async () => {
              started.resolve();
              await gate.promise;
              return { content: [], details: {} };
            }),
          }),
          makeTool({ name: "next", execute: queuedExecute }),
        ],
        { config: directConfig },
        { sessionId, abortSignal },
      );
    const firstBridge = await makeBridge("first-attempt", controller.signal);
    const otherBridge = await makeBridge("other-attempt");
    const first = run(firstBridge, "exclusive");
    const queued = run(firstBridge, "next");
    try {
      await started.promise;
      await flushAsync();
      expect(queuedExecute).not.toHaveBeenCalled();
      await expect(run(otherBridge, "next")).resolves.toMatchObject({ resultType: "success" });
      controller.abort();
      gate.resolve();
      await first;
      await expect(queued).resolves.toMatchObject({
        error: "[copilot-tool-bridge] aborted before execution",
        resultType: "failure",
        textResultForLlm: "[copilot-tool-bridge] aborted before execution",
      });
      expect(queuedExecute).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve();
      await Promise.allSettled([first, queued]);
      firstBridge.cleanup?.();
      otherBridge.cleanup?.();
    }
  });
});
