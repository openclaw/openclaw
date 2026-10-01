import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createOpenClawCodingTools as createRealOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import {
  type AnyAgentTool,
  type SandboxContext,
  wrapToolWithBeforeToolCallHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createContractToolTerminalObserver,
  createOwnerBackedContractTool,
  textToolResult,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { readMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCopilotTestHostCapabilities } from "./host-capability.test-support.js";
import { createCopilotToolBridge as createCopilotToolBridgeImpl } from "./tool-bridge.js";
import {
  convertOpenClawToolToSdkToolForTest,
  createCopilotToolBridge,
  makeInvocation,
  runSdkTool,
  type CopilotCodingToolsOptions,
  type CopilotToolBridgeInput,
} from "./tool-bridge.test-support.js";

type FakeTool = AnyAgentTool & {
  execute: ReturnType<typeof vi.fn>;
  prepareArguments?: ReturnType<typeof vi.fn>;
};

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
    parameters: {
      properties: { value: { type: "string" } },
      type: "object",
    } as never,
    ...overrides,
  } as unknown as FakeTool;
}

function makeTools(...names: string[]) {
  return names.map((name) => makeTool({ name }));
}

function sdkToolNamed(bridge: Awaited<ReturnType<typeof createCopilotToolBridge>>, name: string) {
  return expectDefined(
    bridge.promptToolPolicy.apply().tools.find((tool) => tool.name === name),
    name,
  );
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
function memoryTool() {
  return createOwnerBackedContractTool({
    pluginId: "memory-lancedb",
    name: "memory_forget",
    result: textToolResult("unused"),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createCopilotToolBridge", () => {
  it("rejects a direct caller that omits the required host capability", async () => {
    await expect(
      createCopilotToolBridgeImpl({
        agentId: "agent-1",
        attemptParams: {} as never,
        modelId: "gpt-test",
        modelProvider: "github-copilot",
        sessionId: "session-1",
        spawnWorkspaceDir: undefined,
      }),
    ).rejects.toThrow("Copilot attempt tools require host-bound capabilities");
  });

  it("returns empty arrays for unsupported providers without calling the seam", async () => {
    const createOpenClawCodingTools = vi.fn(() => [makeTool()]);

    const result = await createCopilotToolBridge({
      createOpenClawCodingTools,
      modelProvider: "openai",
    });

    expect(result.codeModeEngaged).toBe(false);
    expect(result.promptToolPolicy.apply()).toEqual({ tools: [], callableToolNames: [] });
    expect(result.sourceTools).toEqual([]);
    expect(createOpenClawCodingTools).toHaveBeenCalledTimes(0);
  });

  it("forwards prepared runtime and provider context to host tool construction", async () => {
    const preparedModelRuntime = {
      metadataSnapshot: {
        plugins: [{ id: "profile-probe", toolMetadata: { probe: { profiles: ["coding"] } } }],
      },
    } as never;
    const createTools = vi.fn((_options?: CopilotCodingToolsOptions) => makeTools("read"));
    await createCopilotToolBridge({
      agentDir: "/agent",
      attemptParams: { preparedModelRuntime, messageProvider: "slack" },
      createOpenClawCodingTools: createTools,
    });
    const options = expectDefined(createTools.mock.calls[0]?.[0], "host construction options");
    expect(options.preparedModelRuntime).toBe(preparedModelRuntime);
    expect(options).toMatchObject({ agentDir: "/agent", messageProvider: "slack" });
  });

  it("compacts tools behind search controls and narrows their callable catalog", async () => {
    const bridge = await createCopilotToolBridge({
      attemptParams: { config: { tools: { toolSearch: true } } },
      createOpenClawCodingTools: (options) =>
        makeTools(
          ...(options?.includeToolSearchControls ? ["tool_search"] : []),
          "fake_hidden",
          "read",
        ),
    });
    const surface = bridge.promptToolPolicy.apply();
    expect(surface.tools.map((tool) => tool.name)).toEqual(["tool_search", "read"]);
    expect(surface.callableToolNames).toEqual(["tool_search", "read", "fake_hidden"]);
    expect(bridge.promptToolPolicy.apply({ toolsAllow: ["fake_hidden"] })).toMatchObject({
      callableToolNames: ["tool_search", "fake_hidden"],
      tools: [expect.objectContaining({ name: "tool_search" })],
    });
    bridge.cleanup?.();
  });

  it("filters the hidden tool_search catalog before compacting narrowed tools", async () => {
    let catalogRef: { current?: { entries?: Array<{ name: string }> } } | undefined;
    const createOpenClawCodingTools = vi.fn((opts: unknown) => {
      catalogRef = (opts as { toolSearchCatalogRef?: typeof catalogRef }).toolSearchCatalogRef;
      return makeTools("tool_search", "read", "edit", "write");
    });

    await createCopilotToolBridge({
      attemptParams: {
        config: { tools: { toolSearch: true } },
        runId: "run-tool-search",
        sessionKey: "agent:agent-1:main",
        toolsAllow: ["read"],
      } as never,
      createOpenClawCodingTools,
    });

    expect(catalogRef?.current?.entries?.map((entry) => entry.name)).toEqual(["read"]);
  });

  it.each([true, false])("uses the executing agent's Code Mode setting (%s)", async (enabled) => {
    const names = ["fake_hidden", "read"];
    const createOpenClawCodingTools = vi.fn(() => names.map((name) => makeTool({ name })));
    const result = await createCopilotToolBridge({
      agentId: "work",
      attemptParams: {
        config: {
          tools: { codeMode: enabled, toolSearch: false },
          agents: {
            entries: {
              work: { tools: { codeMode: enabled } },
              main: { tools: { codeMode: !enabled } },
            },
            defaults: { models: { "github-copilot/gpt-4o": { codeMode: enabled } } },
          },
        },
        runId: `run-code-mode-${enabled}`,
        sessionKey: "agent:work:main",
        sandboxAgentId: "main",
        sandboxSessionKey: "agent:main:policy",
      },
      createOpenClawCodingTools,
    });
    try {
      const visible = enabled ? ["exec", "wait"] : names;
      const surface = result.promptToolPolicy.apply();
      expect(result.codeModeEngaged).toBe(enabled);
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(visible);
      expect(surface.tools.map((tool) => tool.name)).toEqual(visible);
      expect(surface.callableToolNames).toEqual(enabled ? [...visible, ...names] : visible);
      if (enabled) {
        const exec = expectDefined(
          surface.tools.find((tool) => tool.name === "exec"),
          "exec",
        );
        const executed = await runSdkTool(
          exec,
          { code: "return 7;" },
          makeInvocation({ toolName: "exec" }),
        );
        expect(executed).toMatchObject({ resultType: "success" });
        assert(executed && typeof executed === "object" && "textResultForLlm" in executed);
        assert(typeof executed.textResultForLlm === "string");
        expect(JSON.parse(executed.textResultForLlm)).toMatchObject({
          status: "completed",
          value: 7,
        });
      }
    } finally {
      result.cleanup?.();
    }
  });

  it("binds retained code-mode source and SDK controls exactly once", async () => {
    let active = true;
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
    const bridge = await createCopilotToolBridge({
      cwd: "/tmp/copilot-code-mode-cwd",
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
    const sdk = sdkToolNamed(bridge, "exec");
    const copiedSourceExecute = source.execute;
    const copiedSdkHandler = sdk.handler;
    active = false;

    await expect(copiedSourceExecute?.("call-1", { code: "return 1" })).rejects.toThrow(
      "no longer active",
    );
    await expect(copiedSdkHandler?.({ code: "return 1" }, makeInvocation())).resolves.toMatchObject(
      {
        resultType: "failure",
        textResultForLlm: expect.stringContaining("no longer active"),
      },
    );
    expect(bindToolSurface).toHaveBeenCalledTimes(2);
    expect(bindToolSurface.mock.calls.map(([tools]) => tools.map((tool) => tool.name))).toEqual([
      ["read"],
      ["exec", "wait"],
    ]);
    expect(bindToolSurface.mock.calls.map(([, options]) => options)).toEqual([
      { cwd: "/tmp/copilot-code-mode-cwd" },
      { cwd: "/tmp/copilot-code-mode-cwd" },
    ]);
    expect(hiddenExecute).not.toHaveBeenCalled();
  });

  it("throws on duplicate tool names and lists all duplicates", async () => {
    await expect(
      createCopilotToolBridge({
        attemptParams: { toolsAllow: ["alpha", "beta"] },
        createOpenClawCodingTools: () => makeTools("alpha", "beta", "alpha", "beta"),
      }),
    ).rejects.toThrow("duplicate tool names: alpha, beta");
  });

  describe("PI-parity attempt context (F6)", () => {
    function captureCall() {
      const createOpenClawCodingTools = vi.fn((_options?: CopilotCodingToolsOptions) => [
        makeTool(),
      ]);
      return {
        createOpenClawCodingTools,
        getOpts: () => expectDefined(createOpenClawCodingTools.mock.calls[0]?.[0], "tool options"),
      };
    }

    it("quarantines owner memory writes, edits, and patches after a network tool", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-copilot-memory-"));
      await fs.mkdir(path.join(workspaceDir, "memory"));
      try {
        let turnTainted = false;
        const onToolOutcome = vi.fn<
          NonNullable<NonNullable<CopilotToolBridgeInput["attemptParams"]>["onToolOutcome"]>
        >((outcome) => {
          if (!outcome.presentationOnly && outcome.resultContentSource === "network") {
            turnTainted = true;
          }
        });
        const createTools = (options: CopilotCodingToolsOptions = {}) => {
          const filesystemTools = createRealOpenClawCodingTools(options).filter((tool) =>
            ["write", "edit", "apply_patch"].includes(tool.name),
          );
          const networkTool = wrapToolWithBeforeToolCallHook(
            makeTool({ name: "web_fetch", resultContentSource: "network" }),
            {
              agentId: "main",
              sessionKey: options.sessionKey,
              sessionId: options.sessionId,
              runId: options.runId,
              onToolOutcome: options.onToolOutcome,
            },
            { emitDiagnostics: false },
          );
          return [...filesystemTools, networkTool];
        };
        const createMemoryBridge = (sessionId: string, isTurnTainted: () => boolean) =>
          createCopilotToolBridge({
            agentId: "main",
            sessionId,
            workspaceDir,
            attemptParams: {
              config: { tools: { fs: { workspaceOnly: true } } },
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
        const tool = (name: string, source = bridge) => sdkToolNamed(source, name);
        await runSdkTool(tool("write"), {
          path: "memory/trusted.md",
          content: "owner note\n",
        });
        await runSdkTool(tool("web_fetch"), {});
        expect(onToolOutcome).toHaveBeenCalledWith(
          expect.objectContaining({ toolName: "web_fetch", resultContentSource: "network" }),
        );
        expect(turnTainted).toBe(true);

        await runSdkTool(tool("write"), {
          path: "memory/network.md",
          content: "network note\n",
        });
        await runSdkTool(tool("edit"), {
          path: "memory/trusted.md",
          edits: [{ oldText: "owner note", newText: "network edit" }],
        });
        await runSdkTool(tool("apply_patch"), {
          input: [
            "*** Begin Patch",
            "*** Add File: memory/patched.md",
            "+network patch",
            "*** End Patch",
          ].join("\n"),
        });

        const freshBridge = await createMemoryBridge("copilot-fresh-session", () => false);
        await runSdkTool(tool("write", freshBridge), {
          path: "memory/fresh.md",
          content: "fresh owner note\n",
        });

        await expect(
          Promise.all(
            ["memory/trusted.md", "memory/network.md", "memory/patched.md", "memory/fresh.md"].map(
              (relativePath) => readMemoryArtifactProvenance({ workspaceDir, relativePath }),
            ),
          ),
        ).resolves.toEqual([
          expect.objectContaining({ originClass: "untrusted" }),
          expect.objectContaining({ originClass: "untrusted" }),
          expect.objectContaining({ originClass: "untrusted" }),
          expect.objectContaining({ originClass: "agent" }),
        ]);
        await expect(
          fs.readFile(path.join(workspaceDir, "memory/trusted.md"), "utf8"),
        ).resolves.toBe("network edit\n");
        await expect(
          fs.readFile(path.join(workspaceDir, "memory/patched.md"), "utf8"),
        ).resolves.toBe("network patch\n");
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("prefers the unscoped toolAuthProfileStore when building OpenClaw tools", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();
      const authProfileStore = { kind: "transport-scoped-store" } as never;
      const toolAuthProfileStore = { kind: "tool-store" } as never;

      await createCopilotToolBridge({
        attemptParams: {
          authProfileStore,
          toolAuthProfileStore,
        } as never,
        createOpenClawCodingTools,
      });

      expect(getOpts().authProfileStore).toBe(toolAuthProfileStore);
    });

    it.each([undefined, 8000])(
      "uses the effective read context (%s) with prepared model capabilities",
      async (contextTokenBudget) => {
        const { createOpenClawCodingTools, getOpts } = captureCall();

        await createCopilotToolBridge({
          attemptParams: {
            contextTokenBudget,
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
          createOpenClawCodingTools,
        });

        const opts = getOpts();
        expect(opts.modelApi).toBe("openai-responses");
        expect(opts.modelContextWindowTokens).toBe(contextTokenBudget ?? 200_000);
        expect(opts.modelHasVision).toBe(true);
        expect(opts.modelCompat).toEqual({ some: "shape" });
        expect(opts.requesterModel).toEqual({ provider: "openai", model: "gpt-5.6-sol" });
      },
    );

    it("onYield routes to sessionRef.current.abort() and invokes onYieldDetected when the live session is bound", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();
      const abort = vi.fn();
      const sessionRef: { current: { abort?: () => unknown } | undefined } = {
        current: undefined,
      };
      const onYieldDetected = vi.fn();

      await createCopilotToolBridge({
        createOpenClawCodingTools,
        onYieldDetected,
        sessionRef,
      });

      const onYield = getOpts().onYield as (message?: string, acknowledgment?: string) => void;
      expect(() => onYield("early yield", "Starting research.")).not.toThrow();
      expect(abort).toHaveBeenCalledTimes(0);
      expect(onYieldDetected).toHaveBeenCalledTimes(1);
      expect(onYieldDetected).toHaveBeenCalledWith("early yield", "Starting research.");

      sessionRef.current = { abort };
      onYield("now yield");
      expect(abort).toHaveBeenCalledTimes(1);
      expect(onYieldDetected).toHaveBeenCalledTimes(2);
      expect(onYieldDetected).toHaveBeenLastCalledWith("now yield", undefined);
    });

    it("onYield still aborts the live session when onYieldDetected throws (defense in depth)", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();
      const abort = vi.fn();
      const sessionRef: { current: { abort?: () => unknown } | undefined } = {
        current: { abort },
      };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      await createCopilotToolBridge({
        createOpenClawCodingTools,
        onYieldDetected: () => {
          throw new Error("handler boom");
        },
        sessionRef,
      });

      const onYield = getOpts().onYield as (message?: string, acknowledgment?: string) => void;
      expect(() => onYield("handler-fails-but-abort-must-fire")).not.toThrow();
      expect(abort).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it.each([
      { sessionKey: "agent:main:subagent:child", required: undefined, expected: true },
      { sessionKey: "agent:main:subagent:child", required: false, expected: false },
    ])(
      "shares the resolved target requirement for $sessionKey / $required",
      async ({ sessionKey, required, expected }) => {
        const { createOpenClawCodingTools, getOpts } = captureCall();
        const bridge = await createCopilotToolBridge({
          attemptParams: { sessionKey, requireExplicitMessageTarget: required } as never,
          createOpenClawCodingTools,
        });
        expect(getOpts().requireExplicitMessageTarget).toBe(expected);
        expect(bridge.promptToolPolicy.requireExplicitMessageTarget).toBe(expected);
      },
    );
  });

  describe("sandbox forwarding (PR #86155 [P1])", () => {
    function makeSandboxStub(overrides: Partial<SandboxContext> = {}): SandboxContext {
      return {
        enabled: true,
        workspaceAccess: "ro",
        workspaceDir: "/sandbox/copy",
        agentWorkspaceDir: "/sandbox/agent",
        scopeKey: "agent-1:session-1",
        sessionKey: "session-1",
        backend: { kind: "local" } as never,
        cfg: {} as never,
        ...overrides,
      } as unknown as SandboxContext;
    }

    it("forwards an explicit sandbox and spawnWorkspaceDir verbatim to createOpenClawCodingTools", async () => {
      const sandbox = makeSandboxStub();
      const createOpenClawCodingTools = vi.fn(() => [makeTool()]);
      await createCopilotToolBridge({
        createOpenClawCodingTools,
        sandbox,
        sessionKey: "session-1",
        spawnWorkspaceDir: "/original-workspace",
        workspaceDir: "/sandbox/copy",
      });
      const opts = (createOpenClawCodingTools.mock.calls[0] as unknown[] | undefined)?.[0] as {
        sandbox?: unknown;
        spawnWorkspaceDir?: unknown;
        workspaceDir?: unknown;
      };
      expect(opts.sandbox).toBe(sandbox);
      expect(opts.workspaceDir).toBe("/sandbox/copy");
      expect(opts.spawnWorkspaceDir).toBe("/original-workspace");
    });
  });

  describe("tool-surface gating (PR #86155 [P1] round-6)", () => {
    it("keeps collector output callable through empty and narrowed allowlists", async () => {
      const schema = {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      };
      const output = makeTool({ name: "structured_output", catalogMode: "direct-only" });
      const createTools = vi.fn(() => [...makeTools("read"), output]);
      const bridge = await createCopilotToolBridge({
        attemptParams: {
          config: { tools: { codeMode: false, toolSearch: false } },
          toolsAllow: [],
          swarmCollector: true,
          swarmOutputSchema: schema,
        },
        createOpenClawCodingTools: createTools,
      });
      try {
        expect(createTools).toHaveBeenCalledWith(
          expect.objectContaining({
            swarmCollector: true,
            swarmOutputSchema: schema,
            runtimeToolAllowlist: ["structured_output"],
          }),
        );
        expect(bridge.promptToolPolicy.apply().tools.map((tool) => tool.name)).toEqual([
          "structured_output",
        ]);
        const narrowed = bridge.promptToolPolicy.apply({ toolsAllow: ["read"] });
        expect(narrowed.callableToolNames).toContain("structured_output");
        const sdkOutput = expectDefined(
          narrowed.tools.find((tool) => tool.name === "structured_output"),
          "collector output",
        );
        expect(sdkOutput.defer).toBe("never");
        const args = { result: { answer: "ok" } };
        await expect(runSdkTool(sdkOutput, args)).resolves.toEqual({
          resultType: "success",
          textResultForLlm: "done",
        });
        expect(output.execute).toHaveBeenCalledWith("call-1", args, undefined, undefined);
      } finally {
        bridge.cleanup?.();
      }
    });

    it("submits the exact conversation-policy-filtered catalog to the SDK", async () => {
      await withTempDir("openclaw-copilot-policy-", async (workspaceDir) => {
        const result = await createCopilotToolBridge({
          attemptParams: {
            conversationToolPolicy: {
              deny: ["exec", "process", "write", "edit", "ask_user"],
            },
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

        expect(names).toContain("read");
        expect(names).toContain("apply_patch");
        expect(names).not.toContain("exec");
        expect(names).not.toContain("process");
        expect(names).not.toContain("write");
        expect(names).not.toContain("edit");
        expect(names).not.toContain("ask_user");
      });
    });

    it("hands question tools this run's prompt delivery callback", async () => {
      const onToolResult = vi.fn();
      const createOpenClawCodingTools = vi.fn((_options?: CopilotCodingToolsOptions) => []);
      await createCopilotToolBridge({
        attemptParams: { messageChannel: "telegram", onToolResult },
        createOpenClawCodingTools,
      });
      expect(createOpenClawCodingTools).toHaveBeenCalledWith(
        expect.objectContaining({
          questionPrompt: { send: onToolResult, messageChannel: "telegram" },
        }),
      );
    });

    it("enforces the retained sandbox owner's write deny before SDK tool execution", async () => {
      await withTempDir("openclaw-copilot-policy-owner-", async (workspaceDir) => {
        for (const sandboxAgentId of ["marketing", "main"]) {
          const sessionKey = "agent:marketing:policy-owner-test";
          const bridge = await createCopilotToolBridge({
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
            const write = bridge.promptToolPolicy
              .apply()
              .tools.find((tool) => tool.name === "write");
            if (write) {
              const outputPath = path.join(workspaceDir, `${sandboxAgentId}.txt`);
              await expect(
                runSdkTool(write, { path: outputPath, content: "retained policy proof" }),
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

    it.each([{ promptMode: "none" }, { modelRun: true }] as const)(
      "skips tool construction for %j",
      async (attemptParams) => {
        const createOpenClawCodingTools = vi.fn(() => [makeTool()]);
        const result = await createCopilotToolBridge({
          attemptParams,
          createOpenClawCodingTools,
        });
        expect(result.codeModeEngaged).toBe(false);
        expect(result.promptToolPolicy.apply()).toEqual({ tools: [], callableToolNames: [] });
        expect(result.sourceTools).toEqual([]);
        expect(createOpenClawCodingTools).toHaveBeenCalledTimes(0);
      },
    );

    it.each([
      { forceMessageTool: true },
      { sourceReplyDeliveryMode: "message_tool_only" },
    ] as const)(
      "retains forced message delivery through an empty allowlist: %j",
      async (delivery) => {
        const result = await createCopilotToolBridge({
          attemptParams: { toolsAllow: [], ...delivery },
          createOpenClawCodingTools: () => makeTools("read", "message"),
        });
        expect(result.sourceTools.map((tool) => tool.name)).toEqual(["message"]);
      },
    );

    it("does NOT force a message tool when disableMessageTool is true (disable wins over force)", async () => {
      const createOpenClawCodingTools = vi.fn(() => makeTools("read", "message"));
      const result = await createCopilotToolBridge({
        attemptParams: {
          toolsAllow: ["read"],
          forceMessageTool: true,
          disableMessageTool: true,
        } as never,
        createOpenClawCodingTools,
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["read"]);
    });
  });
});

describe("createCopilotToolBridge tool conversion", () => {
  it("throws on empty and non-string names", async () => {
    await expect(
      convertOpenClawToolToSdkToolForTest(makeTool({ name: "" as never }), {}),
    ).rejects.toThrow("tool name must be a non-empty string");
    await expect(
      convertOpenClawToolToSdkToolForTest(makeTool({ name: 42 as never }), {}),
    ).rejects.toThrow("tool name must be a non-empty string");
  });

  it("throws on non-function execute", async () => {
    await expect(
      convertOpenClawToolToSdkToolForTest(makeTool({ execute: "nope" as never }), {}),
    ).rejects.toThrow("must define an execute function");
  });

  it("calls prepareArguments and passes the prepared args and toolCallId to execute", async () => {
    const preparedArgs = { value: "prepared" };
    const onToolCompleted = vi.fn();
    const prepareArguments = vi.fn(() => preparedArgs);
    const executedArguments = { action: "kill", sessionId: "process-1" };
    const observeToolTerminal = vi.fn(() => ({
      executionStarted: true,
      sideEffectEvidence: true,
      executedArguments,
      effectReceipt: { state: "uncertain" as const },
    }));
    const sourceTool = makeTool({ prepareArguments });
    const sdkTool = await convertOpenClawToolToSdkToolForTest(sourceTool, {
      onToolCompleted,
      observeToolTerminal,
    });

    await runSdkTool(sdkTool, { value: "raw" }, makeInvocation({ toolCallId: "call-99" }));

    expect(prepareArguments).toHaveBeenCalledTimes(1);
    expect(prepareArguments).toHaveBeenCalledWith({ value: "raw" });
    expect(sourceTool.execute).toHaveBeenCalledWith("call-99", preparedArgs, undefined, undefined);
    expect(onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ args: executedArguments, toolCallId: "call-99" }),
    );
  });

  it("returns a failure result when prepareArguments throws", async () => {
    const error = new Error("bad args");
    const sourceTool = makeTool({
      prepareArguments: vi.fn(() => {
        throw error;
      }),
    });
    const sdkTool = await convertOpenClawToolToSdkToolForTest(sourceTool, {});

    const result = await runSdkTool(sdkTool, {});

    expect(sourceTool.execute).toHaveBeenCalledTimes(0);
    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm: "[copilot-tool-bridge] prepareArguments failed for tool 'tool-a': bad args",
    });
    expect(result).toMatchObject({ error: error.message });
  });

  it("reports a failed result even when it has no error text", async () => {
    const onToolCompleted = vi.fn();
    const sdkTool = await convertOpenClawToolToSdkToolForTest(
      makeTool({}, { content: [], details: { ok: false } }),
      { onToolCompleted },
    );
    const result = await runSdkTool(sdkTool, {}, makeInvocation({ toolCallId: "no-error-text" }));
    await flushAsync();
    expect(result).toMatchObject({ resultType: "failure" });
    expect(onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "no-error-text", isError: true }),
    );
  });

  it("reports owner-backed failures and clears them after recovery", async () => {
    const tool = memoryTool();
    const onToolCompleted = vi.fn();
    tool.execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("memory delete failed"))
      .mockResolvedValueOnce(textToolResult("Memory forgotten.", { action: "deleted" }));
    const terminal = createTerminalTracker("run-copilot-forget");
    const sdkTool = await convertOpenClawToolToSdkToolForTest(tool, {
      ...terminal,
      onToolCompleted,
    });
    const result = await runSdkTool(
      sdkTool,
      memoryArgs,
      makeInvocation({ toolCallId: "forget-1", toolName: "memory_forget" }),
    );
    expect(terminal.lastError()).toMatchObject({ mutatingAction: true });
    expect(onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        args: memoryArgs,
        error: "memory delete failed",
        toolCallId: "forget-1",
        toolName: "memory_forget",
      }),
    );
    expect(result).toMatchObject({ resultType: "failure", error: "memory delete failed" });
    expect(JSON.stringify(result)).not.toContain("memory-lancedb");

    await runSdkTool(
      sdkTool,
      memoryArgs,
      makeInvocation({ toolCallId: "forget-2", toolName: "memory_forget" }),
    );
    expect(terminal.lastError()).toBeUndefined();
  });

  it("keeps owner-backed failures before execution non-mutating", async () => {
    const controller = new AbortController();
    controller.abort();
    const tool = memoryTool();
    const terminal = createTerminalTracker("run-copilot-pre-execution");
    const sdkTool = await convertOpenClawToolToSdkToolForTest(tool, {
      abortSignal: controller.signal,
      ...terminal,
    });

    await runSdkTool(sdkTool, memoryArgs);

    expect(terminal.lastError()).toMatchObject({
      mutatingAction: false,
    });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("does not classify an unowned same-name Copilot tool as mutating", async () => {
    const terminal = createTerminalTracker("run-copilot-unowned-forget");
    const sdkTool = await convertOpenClawToolToSdkToolForTest(
      makeTool({
        name: "memory_forget",
        execute: vi.fn(async () => {
          throw new Error("third-party failure");
        }),
      }),
      terminal,
    );

    await runSdkTool(sdkTool, memoryArgs);

    expect(terminal.lastError()).toMatchObject({ mutatingAction: false });
    expect(terminal.lastError()).not.toHaveProperty("ownerKey");
  });

  it("reports returned OpenClaw error results to both tool observers", async () => {
    const onAgentToolResult = vi.fn();
    const onToolCompleted = vi.fn();
    const sourceResult = {
      content: [{ text: '{"status":"error","error":"backend unavailable"}', type: "text" }],
      details: { status: "error", error: "backend unavailable" },
    };
    const sdkTool = await convertOpenClawToolToSdkToolForTest(makeTool({}, sourceResult), {
      onAgentToolResult,
      onToolCompleted,
    });

    const result = await runSdkTool(sdkTool, {});
    await flushAsync();

    expect(result).toMatchObject({ resultType: "failure" });
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "tool-a",
      result: sourceResult,
      isError: true,
    });
    expect(onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "backend unavailable",
        result: sourceResult,
      }),
    );
  });

  it("reports owner-backed catalog tool failures to the host terminal observer", async () => {
    type CatalogExecutor = NonNullable<CopilotCodingToolsOptions["toolSearchCatalogExecutor"]>;
    let catalogExecutor: CatalogExecutor | undefined;
    const observeToolTerminal = vi.fn(() => ({
      executionStarted: true,
      sideEffectEvidence: true,
    }));
    await createCopilotToolBridge({
      attemptParams: {
        config: { tools: { toolSearch: true } },
        observeToolTerminal,
        runId: "run-tool-search",
        sessionKey: "agent:agent-1:main",
      } as never,
      createOpenClawCodingTools: (options) => {
        catalogExecutor = options?.toolSearchCatalogExecutor;
        return [makeTool({ name: "tool_search" })];
      },
    });
    const target = memoryTool();
    const error = new Error("catalog delete failed");
    target.execute = vi.fn(async () => {
      throw error;
    });
    const args = { memoryId: "9e107d9d-3729-4ff5-a8c0-01d29c61f49d" };

    await expect(
      expectDefined(
        catalogExecutor,
        "Copilot catalog executor",
      )({
        tool: target,
        toolName: "memory_forget",
        source: "openclaw",
        sourceName: "memory-lancedb",
        toolCallId: "catalog-forget-1",
        parentToolCallId: "tool-search-1",
        input: args,
        acceptResultBeforeProjection: async (result) => result,
      }),
    ).rejects.toThrow("catalog delete failed");

    expect(observeToolTerminal).toHaveBeenCalledWith({
      toolCallId: "catalog-forget-1",
      toolName: "memory_forget",
      result: error,
      arguments: args,
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
    const bridge = await createCopilotToolBridge({
      attemptParams: {
        observeToolTerminal: (observation) => {
          if (observation.toolCallId === "call-0") {
            throw failure;
          }
          return observeTerminal(observation);
        },
      },
      createOpenClawCodingTools: () =>
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
    });
    const runs = bridge.promptToolPolicy
      .apply()
      .tools.map((tool, index) =>
        runSdkTool(tool, {}, makeInvocation({ toolCallId: `call-${index}` })),
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

  it("rechecks abort before a queued tool starts without blocking another attempt", async () => {
    const controller = new AbortController();
    const started = createDeferred<void>();
    const gate = createDeferred<void>();
    const queuedExecute = vi.fn(async () => ({ content: [], details: {} }));
    const makeBridge = (sessionId: string, abortSignal?: AbortSignal) =>
      createCopilotToolBridge({
        sessionId,
        abortSignal,
        createOpenClawCodingTools: () => [
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
      });
    const firstBridge = await makeBridge("first-attempt", controller.signal);
    const otherBridge = await makeBridge("other-attempt");
    const first = runSdkTool(sdkToolNamed(firstBridge, "exclusive"), {});
    const queued = runSdkTool(sdkToolNamed(firstBridge, "next"), {});
    try {
      await started.promise;
      await flushAsync();
      expect(queuedExecute).not.toHaveBeenCalled();
      await expect(runSdkTool(sdkToolNamed(otherBridge, "next"), {})).resolves.toMatchObject({
        resultType: "success",
      });
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
