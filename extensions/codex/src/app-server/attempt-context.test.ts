// Codex tests cover attempt context plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "openclaw/plugin-sdk/memory-host-core";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexOpenClawPromptContext,
  prepareCodexWatchedSessionsContext,
  buildCodexSystemPromptReport,
  readContextEngineThreadBootstrapProjection,
  readMirroredSessionHistoryMessages,
  resolveContextEngineBootstrapProjectionDecision,
} from "./attempt-context.js";
import { buildCodexWorkspaceBootstrapContext } from "./attempt-workspace-context.js";
import type { CodexDynamicToolFunctionSpec, CodexDynamicToolSpec } from "./protocol.js";
import type { CodexAppServerContextEngineBinding } from "./session-binding.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type WorkspaceOptions = Parameters<typeof buildCodexWorkspaceBootstrapContext>[0];
function makeTool(
  name: string,
  overrides: Partial<CodexDynamicToolFunctionSpec> = {},
): CodexDynamicToolFunctionSpec {
  return {
    type: "function",
    name,
    description: name,
    inputSchema: { type: "object" },
    ...overrides,
  };
}
const memoryTools = ["memory_search", "memory_get"].map((name) => makeTool(name));
function namespace(tool: CodexDynamicToolFunctionSpec): CodexDynamicToolSpec {
  return { type: "namespace", name: "openclaw", description: "", tools: [tool] };
}

function workspaceContext(
  workspaceDir: string,
  options: Partial<Omit<WorkspaceOptions, "params">> = {},
  params: Partial<EmbeddedRunAttemptParams> = {},
) {
  return buildCodexWorkspaceBootstrapContext({
    params: {
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      config: { agents: { defaults: { workspace: workspaceDir } } },
      ...params,
    } as EmbeddedRunAttemptParams,
    resolvedWorkspace: workspaceDir,
    effectiveWorkspace: workspaceDir,
    sessionKey: "agent:main:session-1",
    sessionAgentId: "main",
    tools: memoryTools,
    ringZeroActive: false,
    ...options,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  clearMemoryPluginState();
});

describe("Codex app-server attempt context", () => {
  it("treats missing mirrored session history as empty without hook warning", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const sessionFile = path.join(tempDirs.make("codex-attempt-context-history-"), "session.jsonl");
    await expect(
      readMirroredSessionHistoryMessages({
        sessionFile,
        sessionId: "codex-session",
        sessionKey: "codex-session",
      }),
    ).resolves.toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns a run context report without deferred Codex dynamic tool schemas", () => {
    let deferredSchemaReads = 0;
    const tools = [
      makeTool("message", {
        description: "Send a message.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
        },
      }),
      namespace(
        makeTool("web_search", {
          description: "Search the web.",
          inputSchema: {
            type: "object",
            get properties() {
              deferredSchemaReads += 1;
              return { query: { type: "string" } };
            },
          },
          deferLoading: true,
        }),
      ),
    ];

    const reportParams: Parameters<typeof buildCodexSystemPromptReport>[0] = {
      attempt: {
        sessionId: "session-1",
        provider: "codex",
        modelId: "gpt-5.4-codex",
      } as EmbeddedRunAttemptParams,
      sessionKey: "agent:main:session-1",
      workspaceDir: path.join("tmp", "workspace"),
      developerInstructions: "test developer instructions",
      workspaceBootstrapContext: {
        bootstrapFiles: [
          {
            name: "AGENTS.md",
            path: "/workspace/AGENTS.md",
            content: "native instructions",
            missing: false,
            origin: { kind: "agent-workspace", rootPath: "/workspace" },
          },
        ],
        contextFiles: [],
        promptContextFiles: [],
      },
      skillsPrompt: "",
      tools,
    };
    const report = buildCodexSystemPromptReport(reportParams);

    expect(report.source).toBe("run");
    expect(report.provider).toBe("codex");
    expect(report.model).toBe("gpt-5.4-codex");
    expect(report.systemPrompt.chars).toBeGreaterThan(0);
    expect(report.systemPrompt.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.skills.hash).toMatch(/^[a-f0-9]{64}$/u);

    const message = report.tools.entries.find((tool) => tool.name === "message");
    const webSearch = report.tools.deferred?.entries.find((tool) => tool.name === "web_search");
    expect(message?.schemaChars).toBeGreaterThan(0);
    expect(message?.summaryHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(message?.schemaHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.tools.entries.map((tool) => tool.name)).toEqual(["message"]);
    expect(webSearch).toMatchObject({ source: "openclaw", sourceName: "core" });
    expect(webSearch?.schemaChars).toBeGreaterThan(0);
    expect(report.tools.deferred?.schemaChars).toBe(webSearch?.schemaChars);
    expect(report.tools.schemaChars).toBe(message?.schemaChars);
    expect(buildCodexSystemPromptReport(reportParams).tools.deferred).toEqual(
      report.tools.deferred,
    );
    expect(deferredSchemaReads).toBe(1);
    expect(report.injectedWorkspaceFiles).toMatchObject([
      {
        origin: { kind: "agent-workspace", rootPath: "/workspace" },
        injectionStatus: "native_unverified",
        injectedChars: null,
        truncated: null,
      },
    ]);
  });

  it("keeps MEMORY.md injected when sandbox effective workspace differs", async () => {
    const workspaceDir = tempDirs.make("codex-memory-workspace-");
    const sandboxWorkspaceDir = tempDirs.make("codex-memory-sandbox-");
    const memorySummary = "Sandboxed turns need bounded memory fallback.";
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memorySummary);

    const context = await workspaceContext(workspaceDir, {
      effectiveWorkspace: sandboxWorkspaceDir,
    });

    expect(context.memoryReferenceFiles).toEqual([]);
    expect(context.promptContext).toContain(memorySummary);
    expect(context.memoryToolRouted).toBe(false);
  });

  it.each([
    { name: "deferred native tools", lightweight: false },
    { name: "lightweight cron", lightweight: true },
  ])(
    "filters provider guidance independently of workspace routing: $name",
    async ({ lightweight }) => {
      const workspaceDir = tempDirs.make("codex-provider-prompt-");
      const promptBuilder = vi.fn(({ availableTools }: { availableTools: Set<string> }) =>
        availableTools.has("knowledge_lookup") ? ["Recall using knowledge_lookup."] : [],
      );
      registerMemoryCapability("knowledge", { promptBuilder });
      const context = await workspaceContext(
        workspaceDir,
        {
          effectiveWorkspace: path.join(workspaceDir, "sandbox"),
          tools: [
            namespace(
              makeTool("knowledge_lookup", { description: "Look up memory", deferLoading: true }),
            ),
          ],
          sandboxed: true,
        },
        lightweight ? { bootstrapContextMode: "lightweight", bootstrapContextRunKind: "cron" } : {},
      );
      expect(context.memoryToolRouted).toBe(false);
      expect(context.memoryToolNames).toEqual([]);
      expect(context.memoryInstructions).toBe(
        !lightweight ? "Recall using knowledge_lookup." : undefined,
      );
      if (lightweight) {
        expect(promptBuilder).not.toHaveBeenCalled();
      } else {
        expect(promptBuilder).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: "main",
            agentSessionKey: "agent:main:session-1",
            sandboxed: true,
            availableTools: new Set(["knowledge_lookup"]),
          }),
        );
      }
    },
  );

  it("inherits agent workspace instructions when Codex executes in another folder", async () => {
    const workspaceDir = tempDirs.make("codex-agent-workspace-");
    const executionDir = tempDirs.make("codex-execution-workspace-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "Canonical agent instructions");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Canonical agent soul");
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Canonical agent memory");
    await fs.writeFile(path.join(executionDir, "AGENTS.md"), "Execution project instructions");

    const context = await workspaceContext(workspaceDir, {
      executionWorkspace: executionDir,
      effectiveWorkspace: executionDir,
    });

    expect(context.threadDeveloperInstructions).toContain("Canonical agent instructions");
    expect(context.threadDeveloperInstructions).toContain("OpenClaw Agent Workspace Instructions");
    expect(context.threadDeveloperInstructions).toContain(path.join(workspaceDir, "AGENTS.md"));
    expect(context.threadDeveloperInstructions).not.toContain("Canonical agent soul");
    expect(context.threadDeveloperInstructions).not.toContain("Execution project instructions");
    expect(context.threadDeveloperInstructions).not.toContain(path.join(executionDir, "AGENTS.md"));
    expect(context.personaInstructions).toContain("Canonical agent soul");
    expect(context.personaInstructions).not.toContain("Canonical agent instructions");
    expect(context.memoryToolRouted).toBe(true);
    expect(context.promptContext).toBeUndefined();
  });

  it("keeps ambient workspace instructions out of overlapping ring-zero restrictions", async () => {
    const workspaceDir = tempDirs.make("codex-ring-zero-workspace-");
    const executionDir = tempDirs.make("codex-ring-zero-execution-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "Ambient workspace instructions");

    const context = await workspaceContext(
      workspaceDir,
      {
        agentWorkspaceDeveloperInstructions: "Saved ordinary thread instructions",
        executionWorkspace: executionDir,
        effectiveWorkspace: executionDir,
        sessionKey: "agent:openclaw:session-1",
        sessionAgentId: "openclaw",
        tools: [],
        ringZeroActive: true,
      },
      {
        sessionKey: "agent:openclaw:session-1",
        toolsAllow: ["openclaw"],
        pluginHarnessToolPolicyRestricted: true,
      },
    );

    expect(context.threadDeveloperInstructions).toBeUndefined();
    expect(context.threadDeveloperInstructionFiles).toEqual([]);
  });

  it.each([
    {
      name: "ring-zero",
      ringZeroActive: true,
      inheritedWorkspace: true,
      overrides: { toolsAllow: ["openclaw"], pluginHarnessToolPolicyRestricted: true },
    },
    {
      name: "message-only restricted",
      ringZeroActive: false,
      inheritedWorkspace: false,
      overrides: {
        pluginHarnessToolPolicyRestricted: true,
        toolsAllow: ["message"],
        sourceReplyDeliveryMode: "message_tool_only" as const,
      },
    },
  ])(
    "keeps saved workspace instructions suppressed after $name bootstrap failure",
    async (entry) => {
      const bootstrapRuntime = await import("openclaw/plugin-sdk/agent-harness-runtime");
      const failure = new Error("synthetic workspace bootstrap failure");
      const load = vi
        .spyOn(bootstrapRuntime, "prepareAgentWorkspaceContext")
        .mockRejectedValueOnce(failure);
      vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
      const workspaceDir = path.join(os.tmpdir(), "codex-suppressed-bootstrap-workspace");
      const executionDir = entry.inheritedWorkspace
        ? path.join(workspaceDir, "execution")
        : workspaceDir;

      const context = await workspaceContext(
        workspaceDir,
        {
          agentWorkspaceDeveloperInstructions: "Saved ordinary thread instructions",
          executionWorkspace: executionDir,
          effectiveWorkspace: executionDir,
          tools: [],
          ringZeroActive: entry.ringZeroActive,
        },
        entry.overrides,
      );

      expect(load).toHaveBeenCalledOnce();
      expect(context.threadDeveloperInstructions).toBeUndefined();
      expect(context.bootstrapFiles).toEqual([]);
    },
  );

  it("reads and compares thread-bootstrap context-engine projections", () => {
    const projection = readContextEngineThreadBootstrapProjection({
      mode: "thread_bootstrap",
      epoch: " epoch-1 ",
      fingerprint: " fingerprint-1 ",
    });
    expect(projection).toEqual({
      mode: "thread_bootstrap",
      epoch: "epoch-1",
      fingerprint: "fingerprint-1",
    });

    const expectedBinding = {
      schemaVersion: 1,
      engineId: "lossless",
      policyFingerprint: "policy-v1",
      projection: {
        schemaVersion: 1,
        mode: "thread_bootstrap",
        epoch: "epoch-1",
        fingerprint: "fingerprint-1",
      },
    } satisfies CodexAppServerContextEngineBinding;
    expect(
      resolveContextEngineBootstrapProjectionDecision({
        startupBinding: {
          threadId: "thread-existing",
          dynamicToolsFingerprint: "same-tools",
          contextEngine: expectedBinding,
        } as never,
        expectedBinding,
        dynamicToolsFingerprint: "same-tools",
      }),
    ).toEqual({
      project: false,
      reason: "matching-thread-bootstrap-binding",
    });
    expect(
      resolveContextEngineBootstrapProjectionDecision({
        startupBinding: {
          threadId: "thread-existing",
          dynamicToolsFingerprint: "old-tools",
          contextEngine: expectedBinding,
        } as never,
        expectedBinding,
        dynamicToolsFingerprint: "new-tools",
      }),
    ).toEqual({
      project: true,
      reason: "dynamic-tools-mismatch",
    });
  });

  it("stitches watched-session context into the per-turn OpenClaw prompt context", async () => {
    const attempt = { config: {} } as EmbeddedRunAttemptParams;

    expect(
      buildCodexOpenClawPromptContext({
        params: attempt,
        watchedSessionsContext: [
          "## Watched Sessions",
          "- agent:main:telegram:group:beta — Family group",
        ].join("\n"),
      }),
    ).toContain("## Watched Sessions");

    // No ambient watches (and no state) must render nothing, not an empty section.
    expect(
      await prepareCodexWatchedSessionsContext({
        attempt,
        dynamicTools: [makeTool("sessions_history", { description: "history", inputSchema: {} })],
        sessionKey: "agent:codex-test:main",
        assertCurrent: () => {},
      }),
    ).toBe(undefined);
  });
});
