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
import { useAutoCleanupTempDirTracker, withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexOpenClawPromptContext,
  buildCodexWatchedSessionsContext,
  buildCodexSystemPromptReport,
  readContextEngineThreadBootstrapProjection,
  readMirroredSessionHistoryMessages,
  resolveContextEngineBootstrapProjectionDecision,
} from "./attempt-context.js";
import { buildCodexWorkspaceBootstrapContext } from "./attempt-workspace-context.js";
import type { CodexDynamicToolSpec } from "./protocol.js";
import type { CodexAppServerContextEngineBinding } from "./session-binding.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  clearMemoryPluginState();
});

describe("Codex app-server attempt context", () => {
  it("treats missing mirrored session history as empty without hook warning", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-attempt-context-history-"));
    const sessionFile = path.join(dir, "session.jsonl");
    try {
      await expect(
        readMirroredSessionHistoryMessages({
          sessionFile,
          sessionId: "codex-session",
          sessionKey: "codex-session",
        }),
      ).resolves.toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns a run context report without deferred Codex dynamic tool schemas", () => {
    const tools = [
      {
        type: "function",
        name: "message",
        description: "Send a message.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
        },
      },
      {
        type: "namespace",
        name: "openclaw",
        description: "",
        tools: [
          {
            type: "function",
            name: "web_search",
            description: "Search the web.",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
            },
            deferLoading: true,
          },
        ],
      },
    ] as CodexDynamicToolSpec[];

    const report = buildCodexSystemPromptReport({
      attempt: {
        sessionId: "session-1",
        provider: "codex",
        modelId: "gpt-5.4-codex",
      } as EmbeddedRunAttemptParams,
      sessionKey: "agent:main:session-1",
      workspaceDir: path.join("tmp", "workspace"),
      developerInstructions: "test developer instructions",
      workspaceBootstrapContext: {
        bootstrapFiles: [],
        contextFiles: [],
        inheritsAgentWorkspace: false,
        promptContextFiles: [],
      },
      skillsPrompt: "",
      tools,
    });

    expect(report.source).toBe("run");
    expect(report.provider).toBe("codex");
    expect(report.model).toBe("gpt-5.4-codex");
    expect(report.systemPrompt.chars).toBeGreaterThan(0);
    expect(report.systemPrompt.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.skills.hash).toMatch(/^[a-f0-9]{64}$/u);

    const message = report.tools.entries.find((tool) => tool.name === "message");
    const webSearch = report.tools.entries.find((tool) => tool.name === "web_search");
    expect(message?.schemaChars).toBeGreaterThan(0);
    expect(message?.summaryHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(message?.schemaHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(webSearch?.schemaChars).toBe(0);
    expect(webSearch?.summaryHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(webSearch?.schemaHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.tools.schemaChars).toBe(message?.schemaChars);
  });

  it("keeps MEMORY.md injected when sandbox effective workspace differs", async () => {
    await withTempDir("codex-memory-workspace-", async (workspaceDir) => {
      await withTempDir("codex-memory-sandbox-", async (sandboxWorkspaceDir) => {
        const memorySummary = "Sandboxed turns need bounded memory fallback.";
        await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memorySummary);

        const context = await buildCodexWorkspaceBootstrapContext({
          params: {
            sessionId: "session-1",
            sessionKey: "agent:main:session-1",
            config: {
              agents: {
                defaults: {
                  workspace: workspaceDir,
                },
              },
            },
          } as EmbeddedRunAttemptParams,
          resolvedWorkspace: workspaceDir,
          effectiveWorkspace: sandboxWorkspaceDir,
          sessionKey: "agent:main:session-1",
          sessionAgentId: "main",
          tools: ["memory_search", "memory_get"].map((name) => ({
            type: "function",
            name,
            description: name,
            inputSchema: { type: "object" },
          })),
          ringZeroActive: false,
        });

        expect(context.memoryReferenceFiles).toEqual([]);
        expect(context.promptContext).toContain(memorySummary);
        expect(context.memoryToolRouted).toBe(false);
      });
    });
  });

  it.each([
    { name: "deferred native tools", enabled: true, lightweight: false },
    { name: "filtered native tools", enabled: false, lightweight: false },
    { name: "lightweight cron", enabled: true, lightweight: true },
  ])(
    "filters provider guidance independently of workspace routing: $name",
    async ({ enabled, lightweight }) => {
      const workspaceDir = tempDirs.make("codex-provider-prompt-");
      const promptBuilder = vi.fn(({ availableTools }: { availableTools: Set<string> }) =>
        availableTools.has("knowledge_lookup") ? ["Recall using knowledge_lookup."] : [],
      );
      registerMemoryCapability("knowledge", { promptBuilder });
      const context = await buildCodexWorkspaceBootstrapContext({
        params: {
          sessionId: "session-1",
          config: { agents: { defaults: { workspace: workspaceDir } } },
          ...(lightweight
            ? { bootstrapContextMode: "lightweight", bootstrapContextRunKind: "cron" }
            : {}),
        } as EmbeddedRunAttemptParams,
        resolvedWorkspace: workspaceDir,
        effectiveWorkspace: path.join(workspaceDir, "sandbox"),
        sessionKey: "agent:main:session-1",
        sessionAgentId: "main",
        tools: [
          {
            type: "namespace",
            name: "openclaw",
            description: "",
            tools: enabled
              ? [
                  {
                    type: "function",
                    name: "knowledge_lookup",
                    description: "Look up memory",
                    inputSchema: { type: "object" },
                    deferLoading: true,
                  },
                ]
              : [],
          },
        ],
        ringZeroActive: false,
        sandboxed: true,
      });
      expect(context.memoryToolRouted).toBe(false);
      expect(context.memoryToolNames).toEqual([]);
      expect(context.memoryCollaborationInstructions).toBe(
        enabled && !lightweight ? "Recall using knowledge_lookup." : undefined,
      );
      if (lightweight) {
        expect(promptBuilder).not.toHaveBeenCalled();
      } else {
        expect(promptBuilder).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: "main",
            agentSessionKey: "agent:main:session-1",
            sandboxed: true,
            availableTools: new Set(enabled ? ["knowledge_lookup"] : []),
          }),
        );
      }
    },
  );

  it("inherits agent workspace instructions when Codex executes in another folder", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-workspace-"));
    const executionDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-execution-workspace-"));
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "Canonical agent instructions");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Canonical agent soul");
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Canonical agent memory");
    await fs.writeFile(path.join(executionDir, "AGENTS.md"), "Execution project instructions");

    try {
      const context = await buildCodexWorkspaceBootstrapContext({
        params: {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          config: { agents: { defaults: { workspace: workspaceDir } } },
        } as EmbeddedRunAttemptParams,
        resolvedWorkspace: workspaceDir,
        executionWorkspace: executionDir,
        effectiveWorkspace: executionDir,
        sessionKey: "agent:main:session-1",
        sessionAgentId: "main",
        tools: ["memory_search", "memory_get"].map((name) => ({
          type: "function",
          name,
          description: name,
          inputSchema: { type: "object" },
        })),
        ringZeroActive: false,
      });

      expect(context.threadDeveloperInstructions).toContain("Canonical agent instructions");
      expect(context.threadDeveloperInstructions).toContain(
        "OpenClaw Agent Workspace Instructions",
      );
      expect(context.threadDeveloperInstructions).toContain(path.join(workspaceDir, "AGENTS.md"));
      expect(context.threadDeveloperInstructions).not.toContain("Canonical agent soul");
      expect(context.threadDeveloperInstructions).not.toContain("Execution project instructions");
      expect(context.threadDeveloperInstructions).not.toContain(
        path.join(executionDir, "AGENTS.md"),
      );
      expect(context.turnScopedDeveloperInstructions).toContain("Canonical agent soul");
      expect(context.turnScopedDeveloperInstructions).not.toContain("Canonical agent instructions");
      expect(context.memoryToolRouted).toBe(true);
      expect(context.promptContext).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(executionDir, { recursive: true, force: true });
    }
  });

  it("keeps ambient workspace instructions out of overlapping ring-zero restrictions", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-ring-zero-workspace-"));
    const executionDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-ring-zero-execution-"));
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "Ambient workspace instructions");

    try {
      const context = await buildCodexWorkspaceBootstrapContext({
        params: {
          sessionId: "session-1",
          sessionKey: "agent:openclaw:session-1",
          toolsAllow: ["openclaw"],
          pluginHarnessToolPolicyRestricted: true,
          config: { agents: { defaults: { workspace: workspaceDir } } },
        } as EmbeddedRunAttemptParams,
        agentWorkspaceDeveloperInstructions: "Saved ordinary thread instructions",
        resolvedWorkspace: workspaceDir,
        executionWorkspace: executionDir,
        effectiveWorkspace: executionDir,
        sessionKey: "agent:openclaw:session-1",
        sessionAgentId: "openclaw",
        tools: [],
        ringZeroActive: true,
      });

      expect(context.threadDeveloperInstructions).toBeUndefined();
      expect(context.threadDeveloperInstructionFiles).toEqual([]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(executionDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "ring-zero",
      ringZeroActive: true,
      inheritedWorkspace: true,
      overrides: { toolsAllow: ["openclaw"], pluginHarnessToolPolicyRestricted: true },
    },
    {
      name: "lightweight cron",
      ringZeroActive: false,
      inheritedWorkspace: true,
      overrides: { bootstrapContextMode: "lightweight", bootstrapContextRunKind: "cron" },
    },
    {
      name: "tool-disabled restricted",
      ringZeroActive: false,
      inheritedWorkspace: false,
      overrides: { pluginHarnessToolPolicyRestricted: true, disableTools: true },
    },
    {
      name: "message-only restricted",
      ringZeroActive: false,
      inheritedWorkspace: false,
      overrides: {
        pluginHarnessToolPolicyRestricted: true,
        toolsAllow: ["message"],
        sourceReplyDeliveryMode: "message_tool_only",
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

      const context = await buildCodexWorkspaceBootstrapContext({
        params: {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          config: { agents: { defaults: { workspace: workspaceDir } } },
          ...entry.overrides,
        } as EmbeddedRunAttemptParams,
        agentWorkspaceDeveloperInstructions: "Saved ordinary thread instructions",
        resolvedWorkspace: workspaceDir,
        executionWorkspace: executionDir,
        effectiveWorkspace: executionDir,
        sessionKey: "agent:main:session-1",
        sessionAgentId: "main",
        tools: [],
        ringZeroActive: entry.ringZeroActive,
      });

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
        projection: projection!,
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
        projection: projection!,
        dynamicToolsFingerprint: "new-tools",
      }),
    ).toEqual({
      project: true,
      reason: "dynamic-tools-mismatch",
    });
  });

  it("stitches watched-session context into the per-turn OpenClaw prompt context", () => {
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
      buildCodexWatchedSessionsContext({
        attempt,
        dynamicTools: [
          {
            type: "function",
            name: "sessions_history",
            description: "history",
            inputSchema: {},
          },
        ],
        sessionKey: "agent:codex-test:main",
      }),
    ).toBe(undefined);

    // Lightweight cron turns keep the runtime context byte-for-byte untouched.
    expect(
      buildCodexWatchedSessionsContext({
        attempt: {
          config: {},
          bootstrapContextMode: "lightweight",
          bootstrapContextRunKind: "cron",
        } as EmbeddedRunAttemptParams,
        dynamicTools: [],
        sessionKey: "agent:codex-test:main",
      }),
    ).toBe(undefined);
  });
});
