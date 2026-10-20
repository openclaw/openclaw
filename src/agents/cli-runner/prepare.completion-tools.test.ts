import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { assertNoRetainedSessionSharingReads } from "../../config/sessions/session-accessor.sqlite-diagnostics.test-support.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { mintMcpLoopbackClientGrant as MintMcpLoopbackClientGrant } from "../../gateway/mcp-grant-store.js";
import { handleMcpJsonRpc } from "../../gateway/mcp-http.handlers.js";
import {
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "../../gateway/mcp-http.runtime.js";
import { buildMcpToolSchema } from "../../gateway/mcp-http.schema.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServerConfig,
} from "../cli-runner.test-helpers.js";
import * as subagentSpawn from "../subagents/spawn/subagent-spawn.js";
import {
  expectReadWriteEditTools,
  getTextContent,
} from "../test-helpers/agent-tools-fs-helpers.js";
import { requestNativeTool, runPlugin, SUCCESS_RESULT } from "./execute-plugin.test-support.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";
import type { RunCliAgentParams } from "./types.js";

const claudeBackend: CliBackendPlugin & { pluginId: string } = {
  id: "claude-cli",
  pluginId: "anthropic",
  bundleMcp: true,
  bundleMcpMode: "claude-config-file",
  nativeToolMode: "selectable",
  toolAvailabilityEnforcement: "execution-args",
  resolveExecutionArgs: ({ baseArgs }) => [...baseArgs],
  config: {
    command: "claude",
    args: ["--print"],
    output: "jsonl",
    jsonlDialect: "claude-stream-json",
    input: "stdin",
    sessionMode: "existing",
  },
};

/** A completion run whose handoff names a child without persisted lineage. */
function completionRun(sessionTarget: {
  sessionKey: string;
  sessionId: string;
  storePath: string;
}) {
  return {
    sessionKey: sessionTarget.sessionKey,
    sessionId: sessionTarget.sessionId,
    provider: "claude-cli",
    model: "opus",
    trustedInternalHandoff: {
      kind: "subagent-completion",
      sourceSessionKey: "agent:main:subagent:a",
      targetSessionKey: sessionTarget.sessionKey,
      targetSessionId: sessionTarget.sessionId,
      provider: "claude-cli",
      model: "opus",
    },
    inputProvenance: {
      kind: "inter_session",
      sourceTool: "subagent_announce",
      sourceSessionKey: "agent:main:subagent:a",
    },
    config: { session: { store: sessionTarget.storePath } },
  } satisfies Partial<RunCliAgentParams>;
}

describe("restricted CLI tool preparation", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  const mintGrant = vi.fn<typeof MintMcpLoopbackClientGrant>();

  beforeEach(() => {
    mintGrant.mockReset().mockImplementation(createTestMcpLoopbackClientGrant);
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [claudeBackend],
    });
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      makeBootstrapWarn: () => () => undefined,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      getActiveMcpLoopbackRuntime: () => ({
        port: 31783,
        ownerToken: "loopback-owner-token",
        nonOwnerToken: "loopback-non-owner-token",
      }),
      createMcpLoopbackServerConfig: createTestMcpLoopbackServerConfig,
      mintMcpLoopbackClientGrant: mintGrant,
      bindMcpLoopbackClientGrantAdmission: () => true,
      revokeMcpLoopbackClientGrant: () => true,
      resolveMcpLoopbackPolicyTools,
      resolveMcpLoopbackScopedTools,
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      getCliLiveSessionGeneration: () => undefined,
      loadManifestModelCatalog: () => [],
    });
    fixture = createCliRunnerPrepareFixture((params) => {
      setRuntimeConfigSnapshot(params.config ?? {});
      return prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params });
    });
  });

  afterEach(async () => {
    await fixture.settle();
    clearRuntimeConfigSnapshot();
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
  });

  it.each(["global", "agent", "child"])(
    "confines %s workspace-only CLI file tools to the workspace",
    async (scope) => {
      const stateDir = fixture.session.dir;
      const workspaceDir = path.join(stateDir, "workspaces", "main");
      const siblingDir = path.join(stateDir, "workspaces", "other");
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.mkdirSync(siblingDir);
      const stateFile = path.join(stateDir, "openclaw.json");
      const siblingFile = path.join(siblingDir, "note.txt");
      fs.writeFileSync(stateFile, "state fixture");
      fs.writeFileSync(siblingFile, "sibling fixture");
      fs.symlinkSync(siblingDir, path.join(workspaceDir, "outside"), "junction");
      const sessionKey = scope === "child" ? "agent:main:subagent:child" : "agent:main:main";
      const config: OpenClawConfig = {
        session: { store: fixture.session.sessionTarget.storePath },
        tools: {
          profile: "coding",
          exec: { security: "full", ask: "off" },
          fs: { workspaceOnly: scope === "global" },
        },
        agents: {
          entries: {
            main: {
              workspace: workspaceDir,
              ...(scope === "global" ? {} : { tools: { fs: { workspaceOnly: true } } }),
            },
          },
        },
      };
      const context = await fixture.prepare({
        provider: "claude-cli",
        modelHasVision: false,
        workspaceDir,
        sessionKey,
        sessionTarget: { ...fixture.session.sessionTarget, sessionKey },
        config,
      });
      try {
        await runPlugin(context, async function* (execution) {
          await expect(
            requestNativeTool(execution, "Read", { file_path: stateFile }),
          ).resolves.toMatchObject({ behavior: "deny" });
          yield SUCCESS_RESULT;
        });
        const grant = mintGrant.mock.calls[0]?.[0]?.context;
        if (!grant) {
          throw new Error("expected workspace-only MCP tools");
        }
        const scoped = await resolveMcpLoopbackScopedTools({
          cfg: config,
          context: grant,
          admittedRunContext: context.params.admittedRunContext,
        });
        const { readTool, writeTool, editTool } = expectReadWriteEditTools(scoped.tools);
        await writeTool.execute("workspace-write", {
          path: "note.txt",
          content: "workspace fixture",
        });
        expect(getTextContent(await readTool.execute("workspace-read", { path: "note.txt" }))).toBe(
          "workspace fixture",
        );
        await editTool.execute("workspace-edit", {
          path: "note.txt",
          edits: [{ oldText: "workspace fixture", newText: "edited fixture" }],
        });
        expect(fs.readFileSync(path.join(workspaceDir, "note.txt"), "utf8")).toBe("edited fixture");
        for (const filePath of [
          stateFile,
          siblingFile,
          "../../openclaw.json",
          "../other/note.txt",
          "outside/note.txt",
        ]) {
          await expect(readTool.execute("outside-read", { path: filePath })).rejects.toThrow();
          await expect(
            writeTool.execute("outside-write", { path: filePath, content: "changed" }),
          ).rejects.toThrow();
          await expect(
            editTool.execute("outside-edit", {
              path: filePath,
              edits: [{ oldText: "fixture", newText: "changed" }],
            }),
          ).rejects.toThrow();
        }
        expect(fs.readFileSync(stateFile, "utf8")).toBe("state fixture");
        expect(fs.readFileSync(siblingFile, "utf8")).toBe("sibling fixture");
        await expect(
          writeTool.execute("outside-create", { path: "../../new.txt", content: "changed" }),
        ).rejects.toThrow();
        expect(fs.existsSync(path.join(stateDir, "new.txt"))).toBe(false);
      } finally {
        await context.preparedBackend.cleanup?.();
      }
    },
  );

  it("retains native file tools when the agent disables global workspace-only policy", async () => {
    const context = await fixture.prepare({
      provider: "claude-cli",
      sessionKey: "agent:main:main",
      config: {
        session: { store: fixture.session.sessionTarget.storePath },
        tools: { fs: { workspaceOnly: true }, exec: { security: "full", ask: "off" } },
        agents: { entries: { main: { tools: { fs: { workspaceOnly: false } } } } },
      },
    });
    try {
      await runPlugin(context, async function* (execution) {
        await expect(
          requestNativeTool(execution, "Read", {
            file_path: path.join(fixture.session.dir, "openclaw.json"),
          }),
        ).resolves.toMatchObject({ behavior: "allow" });
        yield SUCCESS_RESULT;
      });
    } finally {
      await context.preparedBackend.cleanup?.();
    }
  });

  it("retains an exact file-tool selection when applying workspace-only policy", async () => {
    const config: OpenClawConfig = {
      session: { store: fixture.session.sessionTarget.storePath },
      tools: { profile: "coding", fs: { workspaceOnly: true } },
    };
    const context = await fixture.prepare({
      provider: "claude-cli",
      sessionKey: "agent:main:main",
      modelHasVision: false,
      cliToolAvailability: { native: [], openClaw: ["write"] },
      config,
    });
    try {
      const grant = mintGrant.mock.calls[0]?.[0]?.context;
      if (!grant) {
        throw new Error("expected workspace-only MCP tools");
      }
      const scoped = await resolveMcpLoopbackScopedTools({
        cfg: config,
        context: grant,
        admittedRunContext: context.params.admittedRunContext,
      });
      expect(scoped.tools.map((tool) => tool.name)).toEqual(["write"]);
    } finally {
      await context.preparedBackend.cleanup?.();
    }
  });

  it.each(["agent", "side-question", "preparation-error"] as const)(
    "releases direct CLI tool authority after %s",
    async (outcome) => {
      if (outcome === "preparation-error") {
        setCliRunnerPrepareTestDeps({
          resolveBootstrapContextForRun: async () => {
            throw new Error("bootstrap preparation failed");
          },
        });
      }
      const pending = fixture.prepare({
        provider: "claude-cli",
        model: "opus",
        modelHasVision: false,
        sessionKey: fixture.session.sessionTarget.sessionKey,
        config: { session: { store: fixture.session.sessionTarget.storePath } },
        ...(outcome === "side-question" ? { executionMode: "side-question" } : {}),
      });
      if (outcome === "preparation-error") {
        await expect(pending).rejects.toThrow("bootstrap preparation failed");
      } else {
        const context = await pending;
        await context.preparedBackend.cleanup?.();
      }
      assertNoRetainedSessionSharingReads();
    },
  );

  it.each([
    "conversation",
    "sender config",
    "group config",
    "persisted allow",
    "persisted deny",
    "persisted rootless",
    "persisted rootless workspace fallback",
  ])(
    "mediates a sender-restricted turn from %s and retains its root and spawn restriction",
    async (source) => {
      const sessionRoot = path.join(fixture.session.dir, "requester-task");
      fs.mkdirSync(sessionRoot);
      const rootless = source.includes("rootless");
      const needsWorkspaceFallback = source === "persisted rootless workspace fallback";
      const workspaceDir = rootless ? sessionRoot : fixture.session.dir;
      const outsidePath = path.join(fixture.session.dir, "outside-task.txt");
      fs.writeFileSync(outsidePath, "outside requester root");
      const conversationToolPolicy = {
        allow: ["read", "sessions_spawn"],
        deny: ["exec"],
      };
      const persisted = source.startsWith("persisted");
      const sessionKey = persisted
        ? "agent:main:subagent:restricted-child"
        : source === "group config"
          ? "agent:main:telegram:group:chat-1"
          : fixture.session.sessionTarget.sessionKey;
      const sessionEntry: SessionEntry = {
        sessionId: fixture.session.sessionTarget.sessionId,
        updatedAt: 1,
        permissionMode: "read-only",
        sessionRoot: rootless ? undefined : sessionRoot,
        ...(persisted
          ? {
              spawnedBy: "agent:main:main",
              spawnDepth: 1,
              inheritedToolPolicyVersion: 1,
              inheritedToolPolicySource: "sender",
              inheritedToolAllow:
                source === "persisted deny"
                  ? []
                  : rootless
                    ? ["read", "write", "sessions_spawn"]
                    : ["read", "sessions_spawn"],
              inheritedToolDeny: ["exec"],
            }
          : {}),
      };
      const sessionTarget = { ...fixture.session.sessionTarget, sessionKey };
      replaceSessionEntrySync(sessionTarget, sessionEntry);
      const config: OpenClawConfig = {
        session: { store: fixture.session.sessionTarget.storePath },
        agents: {
          defaults: {
            subagents: { maxSpawnDepth: 2 },
            ...(needsWorkspaceFallback ? { workspace: workspaceDir } : {}),
          },
        },
        ...(source === "sender config"
          ? { tools: { toolsBySender: { "id:guest": conversationToolPolicy } } }
          : {}),
        ...(source === "group config"
          ? { channels: { telegram: { groups: { "chat-1": { tools: conversationToolPolicy } } } } }
          : {}),
        ...(source === "conversation"
          ? { mcp: { servers: { userProbe: { command: "node", args: ["user-probe.mjs"] } } } }
          : {}),
      };
      const context = await fixture.prepare({
        provider: "claude-cli",
        model: "opus",
        modelHasVision: false,
        conversationToolPolicy: source === "conversation" ? conversationToolPolicy : undefined,
        messageProvider: "telegram",
        senderId: persisted ? undefined : "guest",
        senderIsOwner: false,
        sessionKey,
        sessionFile: sessionKey,
        sessionTarget,
        sessionEntry,
        workspaceDir: needsWorkspaceFallback ? "   " : workspaceDir,
        config,
      });
      const launch = vi.spyOn(subagentSpawn, "spawnSubagentDirect").mockResolvedValue({
        status: "accepted",
        context: "isolated",
        childSessionKey: "agent:main:subagent:restricted-root-helper",
        runId: "restricted-root-helper",
      });
      try {
        const grant = mintGrant.mock.calls[0]?.[0]?.context;
        expect(grant).toBeDefined();
        if (!grant) {
          throw new Error("expected a channel-restricted MCP grant");
        }
        expect(context.params.cliToolAvailability).toEqual({
          native: [],
          openClaw: expect.arrayContaining(["read", "sessions_spawn"]),
        });
        expect(grant.toolsAllow).not.toContain("exec");
        if (source !== "persisted deny") {
          expect(grant.toolsAllow?.toSorted()).toEqual(["read", "sessions_spawn"]);
        }
        expect(grant.conversationToolPolicy).toEqual(
          source === "conversation" ? conversationToolPolicy : undefined,
        );
        const scoped = await resolveMcpLoopbackScopedTools({
          cfg: config,
          context: grant,
          admittedRunContext: context.params.admittedRunContext,
        });
        expect(scoped.tools.map((tool) => tool.name)).not.toContain("write");
        const spawn = scoped.tools.find((tool) => tool.name === "sessions_spawn");
        if (!spawn) {
          throw new Error("expected the permitted spawn tool");
        }
        await expect(
          spawn.execute("restricted-visible", { task: "helper", visible: true }),
        ).resolves.toMatchObject({
          details: {
            status: "forbidden",
            error: "This sender may only start hidden helpers of the same agent.",
          },
        });
        await expect(spawn.execute("restricted-hidden", { task: "helper" })).resolves.toMatchObject(
          {
            details: { status: "accepted" },
          },
        );
        expect(launch.mock.calls[0]?.[1]).toMatchObject({
          inheritedToolPolicySource: "sender",
          workspaceDir,
          sessionPermissionPolicy: { mode: "read-only", root: sessionRoot },
        });
        const read = scoped.tools.find((tool) => tool.name === "read");
        if (!read) {
          throw new Error("expected the permitted read tool");
        }
        await expect(read.execute("restricted-root-read", { path: outsidePath })).rejects.toThrow();
        const args = context.preparedBackend.backend.args ?? [];
        const mcpConfigPath = args[args.indexOf("--mcp-config") + 1];
        const bundle = JSON.parse(fs.readFileSync(mcpConfigPath ?? "", "utf-8")) as {
          mcpServers: Record<string, unknown>;
        };
        expect(Object.keys(bundle.mcpServers)).toEqual(["openclaw"]);
      } finally {
        launch.mockRestore();
        await context.preparedBackend.cleanup?.();
      }
    },
  );

  it.each([
    {
      name: "without exact tool selection",
      nativeToolMode: "always-on" as const,
      execHost: undefined,
    },
    {
      name: "with node execution",
      nativeToolMode: "selectable" as const,
      execHost: "node" as const,
    },
  ])("refuses a persisted sender-restricted child $name", async ({ nativeToolMode, execHost }) => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [{ ...claudeBackend, nativeToolMode }],
    });
    const sessionKey = "agent:main:subagent:restricted-child";
    const sessionEntry: SessionEntry = {
      sessionId: fixture.session.sessionTarget.sessionId,
      updatedAt: 1,
      spawnedBy: "agent:main:main",
      spawnDepth: 1,
      inheritedToolPolicyVersion: 1,
      inheritedToolPolicySource: "sender",
      inheritedToolAllow: ["read", "sessions_spawn"],
      inheritedToolDeny: ["exec"],
      execHost,
    };
    const sessionTarget = { ...fixture.session.sessionTarget, sessionKey };
    replaceSessionEntrySync(sessionTarget, sessionEntry);
    await expect(
      fixture.prepare({
        provider: "claude-cli",
        sessionKey,
        sessionFile: sessionKey,
        sessionTarget,
        sessionEntry,
        config: { session: { store: sessionTarget.storePath } },
      }),
    ).rejects.toThrow("cannot enforce conversation tool policy");
    expect(mintGrant).not.toHaveBeenCalled();
  });

  it.each([
    { name: "bundled MCP", backend: { bundleMcp: false } },
    { name: "exact native tool selection", backend: { nativeToolMode: "always-on" as const } },
  ])("refuses a channel-restricted turn without $name", async ({ backend }) => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [{ ...claudeBackend, ...backend }],
    });
    await expect(
      fixture.prepare({
        provider: "claude-cli",
        conversationToolPolicy: { deny: ["exec"] },
      }),
    ).rejects.toThrow("cannot enforce conversation tool policy");
    expect(mintGrant).not.toHaveBeenCalled();
  });

  it.each([false, undefined])(
    "keeps the CLI catalog stable while gating persisted completion authority with owner=%s",
    async (senderIsOwner) => {
      const { sessionTarget } = fixture.session;
      const childSessionKey = "agent:main:subagent:completion-review";
      const inheritedToolDeny = ["terminal", "gateway", "write", "edit", "apply_patch"];
      replaceSessionEntrySync(
        { storePath: sessionTarget.storePath, sessionKey: childSessionKey },
        {
          sessionId: "completion-child",
          updatedAt: 1,
          spawnedBy: sessionTarget.sessionKey,
          spawnDepth: 1,
          subagentRole: "orchestrator",
          subagentControlScope: "children",
          inheritedToolPolicyVersion: 1,
          inheritedToolDeny,
          inheritedToolAllow: ["read", "exec", "write", "intent"],
        },
      );
      const trustedInternalHandoff = {
        kind: "subagent-completion" as const,
        sourceSessionKey: childSessionKey,
        sourceSessionId: "completion-child",
        targetSessionKey: sessionTarget.sessionKey,
        targetSessionId: sessionTarget.sessionId,
        provider: "claude-cli",
        model: "opus",
      };
      const run = {
        sessionKey: sessionTarget.sessionKey,
        sessionId: sessionTarget.sessionId,
        provider: "claude-cli",
        model: "opus",
        modelHasVision: false,
        sourceReplyDeliveryMode: "automatic",
        toolsAllow: ["read", "exec", "write", "gateway", "intent"],
        config: {
          plugins: { allow: ["memory-core"], entries: { "memory-core": { enabled: true } } },
          session: { store: sessionTarget.storePath },
          tools: {
            deny: ["apply_patch"],
            toolsBySender: {
              "id:owner": { allow: ["*"] },
              "*": { deny: ["group:runtime", "group:fs"] },
            },
          },
          mcp: { servers: { userProbe: { command: "node", args: ["user-probe.mjs"] } } },
        },
      } satisfies Partial<RunCliAgentParams>;
      const owner = await fixture.prepare({ ...run, senderId: "owner", senderIsOwner: true });
      const ownerGrant = mintGrant.mock.calls[0]![0].context;
      const ownerTools = await resolveMcpLoopbackScopedTools({
        cfg: run.config,
        context: ownerGrant,
        admittedRunContext: owner.params.admittedRunContext,
      });
      await owner.preparedBackend.cleanup?.();
      setCliRunnerPrepareTestDeps({
        claudeCliSessionTranscriptHasContent: async () => true,
        claudeCliSessionTranscriptHasOrphanedToolUse: async () => false,
      });
      const context = await fixture.prepare({
        ...run,
        senderIsOwner,
        cliSessionBinding: {
          sessionId: "native-parent-session",
          authEpoch: owner.authEpoch,
          authEpochVersion: owner.authEpochVersion,
          extraSystemPromptHash: owner.extraSystemPromptHash,
          messageToolPolicyHash: owner.messageToolPolicyHash,
          promptToolNamesHash: owner.promptToolNamesHash,
          cwdHash: owner.cwdHash,
          mcpConfigHash: owner.preparedBackend.mcpConfigHash,
          mcpResumeHash: owner.preparedBackend.mcpResumeHash,
        },
        trustedInternalHandoff,
        inputProvenance: {
          kind: "inter_session",
          sourceTool: "subagent_announce",
          sourceSessionKey: childSessionKey,
        },
      });
      try {
        const grant = mintGrant.mock.calls[1]![0].context;
        expect(grant).toBeDefined();
        expect(context.params.cliToolAvailability?.native).toEqual([]);
        expect(ownerGrant.toolsAllow?.toSorted()).toEqual([
          "exec",
          "gateway",
          "intent",
          "read",
          "write",
        ]);
        expect(grant.toolsAllow).toEqual(ownerGrant.toolsAllow);
        expect(context.promptToolNamesHash).toBe(owner.promptToolNamesHash);
        expect(context.reusableCliSession).toEqual({
          mode: "reuse",
          sessionId: "native-parent-session",
        });
        expect(grant.toolsAllow).toEqual(context.params.cliToolAvailability?.openClaw);
        expect(grant.trustedInternalHandoff).toEqual(trustedInternalHandoff);
        const scoped = await resolveMcpLoopbackScopedTools({
          cfg: run.config,
          context: grant,
          admittedRunContext: context.params.admittedRunContext,
        });
        const toolSchema = buildMcpToolSchema(scoped.tools);
        expect(toolSchema).toEqual(buildMcpToolSchema(ownerTools.tools));
        const deniedPath = path.join(fixture.session.dir, "completion-must-not-write.txt");
        for (const [name, args, denial] of [
          [
            "write",
            { path: deniedPath, content: "must not execute" },
            "write is outside the authority this completion turn carries from its requester. Do not retry write.",
          ],
          [
            "gateway",
            { action: "config.get" },
            "gateway needs the owner's authority, and this turn was not started by the owner. Do not retry gateway.",
          ],
          [
            "intent",
            { action: "create", description: "Must not create", triggerKeywords: ["completion"] },
            "intent needs the owner's authority, and this turn was not started by the owner. Do not retry intent.",
          ],
        ] as const) {
          await expect(
            handleMcpJsonRpc({
              message: {
                jsonrpc: "2.0",
                id: name,
                method: "tools/call",
                params: { name, arguments: args },
              },
              tools: scoped.tools,
              toolSchema,
            }),
          ).resolves.toMatchObject({ result: { content: [{ type: "text", text: denial }] } });
        }
        expect(fs.existsSync(deniedPath)).toBe(false);
        const args = context.preparedBackend.backend.args ?? [];
        const mcpConfigPath = args[args.indexOf("--mcp-config") + 1];
        const bundle = JSON.parse(fs.readFileSync(mcpConfigPath ?? "", "utf-8")) as {
          mcpServers: Record<string, unknown>;
        };
        expect(Object.keys(bundle.mcpServers)).toEqual(["openclaw"]);
      } finally {
        await context.preparedBackend.cleanup?.();
      }
    },
  );

  it.each([
    {
      name: "a node-hosted requester",
      run: { sessionEntry: { sessionId: "session-test", updatedAt: 1, execHost: "node" } },
    },
    {
      name: "a settle batch",
      handoff: {
        settleBatch: { sourceSessionKeys: ["agent:main:subagent:a"], isCurrent: () => true },
      },
    },
    { name: "a backend without bundled MCP", backend: { bundleMcp: false } },
    { name: "a backend without exact tool selection", backend: { nativeToolMode: "always-on" } },
  ] satisfies Array<{
    name: string;
    run?: Partial<RunCliAgentParams>;
    handoff?: Partial<NonNullable<RunCliAgentParams["trustedInternalHandoff"]>>;
    backend?: Partial<CliBackendPlugin>;
  }>)("refuses trusted completion tools for $name", async (testCase) => {
    const run = completionRun(fixture.session.sessionTarget);
    if ("backend" in testCase) {
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [{ ...claudeBackend, ...testCase.backend }],
      });
    }
    await expect(
      fixture.prepare({
        ...run,
        trustedInternalHandoff: {
          ...run.trustedInternalHandoff,
          ...("handoff" in testCase ? testCase.handoff : {}),
        },
        ...("run" in testCase ? testCase.run : {}),
      }),
    ).rejects.toThrow("cannot enforce completion tool policy");
    expect(mintGrant).not.toHaveBeenCalled();
  });

  it("lets disableTools override a completion's runtime tool cap", async () => {
    const context = await fixture.prepare({
      ...completionRun(fixture.session.sessionTarget),
      disableTools: true,
      toolsAllow: ["write"],
    });
    try {
      expect(context.params.cliToolAvailability).toEqual({ native: [], openClaw: [] });
      expect(context.params.toolsAllow).toBeUndefined();
    } finally {
      await context.preparedBackend.cleanup?.();
    }
  });
});
