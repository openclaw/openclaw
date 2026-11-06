import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { assertNoRetainedSessionSharingReads } from "../../config/sessions/session-accessor.sqlite-diagnostics.test-support.js";
import type { CliSessionBinding, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { mintMcpLoopbackClientGrant as MintMcpLoopbackClientGrant } from "../../gateway/mcp-grant-store.js";
import { handleMcpJsonRpc } from "../../gateway/mcp-http.handlers.js";
import {
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "../../gateway/mcp-http.runtime.js";
import { buildMcpToolSchema } from "../../gateway/mcp-http.schema.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServerConfig,
} from "../cli-runner.test-helpers.js";
import { resolveCliSessionReuse } from "../cli-session.js";
import * as subagentSpawn from "../subagents/spawn/subagent-spawn.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";
import type { RunCliAgentParams } from "./types.js";

const { buildAnthropicCliBackend } = await loadBundledPluginFacade<{
  buildAnthropicCliBackend: () => CliBackendPlugin;
}>({ pluginId: "anthropic", artifactBasename: "api.js" });

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
      revokeMintedMcpLoopbackClientGrant: () => true,
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

  it("keeps the Claude tool and system prefix across ordinary and completion turns", async () => {
    const nativeBackend = buildAnthropicCliBackend();
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        {
          ...claudeBackend,
          prepareExecution: nativeBackend.prepareExecution,
          resolveExecutionArgs: nativeBackend.resolveExecutionArgs,
          transformSystemPrompt: nativeBackend.transformSystemPrompt,
        },
      ],
    });
    const { sessionTarget } = fixture.session;
    const skillPath = path.join(fixture.session.dir, "SKILL.md");
    const skillPrompt = `<available_skills><skill><name>cache-fixture</name><description>Check the prefix.</description><location>${skillPath}</location></skill></available_skills>`;
    fs.writeFileSync(
      skillPath,
      "---\nname: cache-fixture\ndescription: Check the prefix.\n---\nRead the current facts.\n",
    );
    const nativeSkillsPlugin = vi.fn(async () => ({
      args: ["--plugin-dir", "/synthetic/native-skills"],
      cleanup: async () => {},
    }));
    setCliRunnerPrepareTestDeps({ prepareClaudeCliSkillsPlugin: nativeSkillsPlugin });
    const childSessionKey = "agent:main:subagent:cache-prefix";
    replaceSessionEntrySync(
      { storePath: sessionTarget.storePath, sessionKey: childSessionKey },
      {
        sessionId: "cache-prefix-child",
        updatedAt: 1,
        spawnedBy: sessionTarget.sessionKey,
        spawnDepth: 1,
        inheritedToolPolicyVersion: 1,
        inheritedToolAllow: ["read"],
      },
    );
    const base = {
      sessionKey: sessionTarget.sessionKey,
      sessionId: sessionTarget.sessionId,
      provider: "claude-cli",
      model: "opus",
      modelHasVision: false,
      sourceReplyDeliveryMode: "automatic" as const,
      skillsSnapshot: {
        prompt: skillPrompt,
        skills: [{ name: "cache-fixture" }],
        resolvedSkills: [
          {
            name: "cache-fixture",
            description: "Check the prefix.",
            filePath: skillPath,
            baseDir: fixture.session.dir,
            source: "openclaw-workspace",
            sourceInfo: {
              path: skillPath,
              source: "openclaw-workspace",
              scope: "project" as const,
              origin: "top-level" as const,
              baseDir: fixture.session.dir,
            },
            disableModelInvocation: false,
          },
        ],
      },
      config: {
        session: { store: sessionTarget.storePath },
        tools: { allow: ["read"] },
      },
    };
    const turns = [];
    for (const completion of [false, true, false]) {
      const context = await fixture.prepare({
        ...base,
        ...(completion
          ? {
              trustedInternalHandoff: {
                kind: "subagent-completion" as const,
                sourceSessionKey: childSessionKey,
                sourceSessionId: "cache-prefix-child",
                targetSessionKey: sessionTarget.sessionKey,
                targetSessionId: sessionTarget.sessionId,
                provider: "claude-cli",
                model: "opus",
              },
              inputProvenance: {
                kind: "inter_session" as const,
                sourceTool: "subagent_announce",
                sourceSessionKey: childSessionKey,
              },
            }
          : {}),
      });
      try {
        expect(context.executionTarget.kind).toBe("plugin");
        expect(context.promptContext?.appendContext).toBeTruthy();
        expect(context.systemPrompt).toContain("cache-fixture");
        const executionArgs =
          context.backendResolved.resolveExecutionArgs?.({
            config: context.params.config,
            workspaceDir: context.workspaceDir,
            provider: context.params.provider,
            modelId: context.modelId,
            executionMode: "agent",
            toolAvailability: context.params.cliToolAvailability,
            hostOwnedTools: context.hostOwnedTools,
            useResume: completion,
            baseArgs: context.preparedBackend.backend.args ?? [],
          }) ?? [];
        turns.push({
          availability: context.params.cliToolAvailability,
          systemPrompt: context.systemPrompt,
          toolsAllow: mintGrant.mock.lastCall?.[0]?.context.toolsAllow,
          nativeTools: executionArgs[executionArgs.indexOf("--tools") + 1],
          allowedTools: executionArgs[executionArgs.indexOf("--allowedTools") + 1],
        });
        expect(executionArgs).not.toContain("--plugin-dir");
      } finally {
        await context.preparedBackend.cleanup?.();
      }
    }
    expect(turns[0]?.availability).toEqual({ native: [], openClaw: ["read"] });
    expect(turns[0]?.toolsAllow).toEqual(["read"]);
    expect(turns[0]?.nativeTools).toBe("");
    expect(turns[0]?.allowedTools).toBe("mcp__openclaw__read");
    expect(turns[1]).toEqual(turns[0]);
    expect(turns[2]).toEqual(turns[0]);
    expect(nativeSkillsPlugin).not.toHaveBeenCalled();
  });

  it("keeps the Claude session across Control UI turns and caller-less completion turns", async () => {
    const { sessionTarget } = fixture.session;
    const childSessionKey = "agent:main:subagent:surface-tools";
    replaceSessionEntrySync(
      { storePath: sessionTarget.storePath, sessionKey: childSessionKey },
      {
        sessionId: "surface-tools-child",
        updatedAt: 1,
        spawnedBy: sessionTarget.sessionKey,
        spawnDepth: 1,
        inheritedToolPolicyVersion: 1,
        inheritedToolAllow: ["read", "screen", "show_widget", "suggest_task", "dismiss_task"],
      },
    );
    const base = {
      sessionKey: sessionTarget.sessionKey,
      sessionId: sessionTarget.sessionId,
      provider: "claude-cli",
      model: "opus",
      modelHasVision: false,
      sourceReplyDeliveryMode: "automatic" as const,
      config: {
        session: { store: sessionTarget.storePath },
        tools: { allow: ["read", "screen", "show_widget", "suggest_task", "dismiss_task"] },
      },
    };
    const turns: { binding: CliSessionBinding; systemPrompt: string }[] = [];
    for (const completion of [false, true, false]) {
      const context = await fixture.prepare({
        ...base,
        ...(completion
          ? {
              trustedInternalHandoff: {
                kind: "subagent-completion" as const,
                sourceSessionKey: childSessionKey,
                sourceSessionId: "surface-tools-child",
                targetSessionKey: sessionTarget.sessionKey,
                targetSessionId: sessionTarget.sessionId,
                provider: "claude-cli",
                model: "opus",
              },
              inputProvenance: {
                kind: "inter_session" as const,
                sourceTool: "subagent_announce",
                sourceSessionKey: childSessionKey,
              },
            }
          : {
              clientCaps: ["ui-commands", "inline-widgets"],
              taskSuggestionDeliveryMode: "gateway" as const,
            }),
      });
      try {
        turns.push({
          binding: {
            sessionId: "native-surface-session",
            authEpoch: context.authEpoch,
            authEpochVersion: context.authEpochVersion,
            extraSystemPromptHash: context.extraSystemPromptHash,
            messageToolPolicyHash: context.messageToolPolicyHash,
            promptToolNamesHash: context.promptToolNamesHash,
            cwdHash: context.cwdHash,
            mcpConfigHash: context.preparedBackend.mcpConfigHash,
            mcpResumeHash: context.preparedBackend.mcpResumeHash,
          },
          systemPrompt: context.systemPrompt,
        });
      } finally {
        await context.preparedBackend.cleanup?.();
      }
    }
    expect(turns[0]!.binding.promptToolNamesHash).toBeTruthy();
    expect(turns[1]!.systemPrompt).not.toBe(turns[0]!.systemPrompt);
    expect(turns[2]!.systemPrompt).toBe(turns[0]!.systemPrompt);
    for (const [index, turn] of turns.slice(1).entries()) {
      const { authEpochVersion, ...current } = turn.binding;
      expect(
        resolveCliSessionReuse({
          ...current,
          authEpochVersion: authEpochVersion!,
          binding: turns[index]!.binding,
        }),
      ).toMatchObject({ sessionId: "native-surface-session" });
    }
  });

  it.each(["completion", "stopped-child completion", "automation"] as const)(
    "keeps the owner's Claude session across the %s turn",
    async (flow) => {
      // Bundled claude-cli: owner turns use native file tools, completion turns mediate
      // them through loopback, and non-owner turns lose owner authority (#186684).
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [{ ...buildAnthropicCliBackend(), pluginId: "anthropic" }],
      });
      const { sessionTarget } = fixture.session;
      const childSessionKey = "agent:main:subagent:continuity";
      replaceSessionEntrySync(
        { storePath: sessionTarget.storePath, sessionKey: childSessionKey },
        {
          sessionId: "continuity-child",
          updatedAt: 1,
          spawnedBy: sessionTarget.sessionKey,
          spawnDepth: 1,
          inheritedToolPolicyVersion: 1,
          inheritedToolAllow: ["read", "exec", "web_fetch"],
        },
      );
      const config = { session: { store: sessionTarget.storePath } };
      const completion = {
        trustedInternalHandoff: {
          kind: "subagent-completion" as const,
          sourceSessionKey: childSessionKey,
          sourceSessionId: "continuity-child",
          targetSessionKey: sessionTarget.sessionKey,
          targetSessionId: sessionTarget.sessionId,
          provider: "claude-cli",
          model: "opus",
        },
        inputProvenance: {
          kind: "inter_session" as const,
          sourceTool: "subagent_announce",
          sourceSessionKey: childSessionKey,
        },
      };
      const flows = {
        completion,
        // A stopped child's completion and a session-targeted automation run without owner authority.
        "stopped-child completion": { ...completion, senderIsOwner: false },
        automation: { senderIsOwner: false, trigger: "cron" as const },
      } satisfies Record<typeof flow, Partial<RunCliAgentParams>>;
      const owner = { senderIsOwner: true };
      const turns = [
        ["owner", owner],
        [flow, flows[flow]],
        ["owner", owner],
      ] satisfies Array<[string, Partial<RunCliAgentParams>]>;
      let previous: { kind: string; binding: CliSessionBinding; names: string[] } | undefined;
      for (const [kind, turn] of turns) {
        const context = await fixture.prepare({
          sessionKey: sessionTarget.sessionKey,
          sessionId: sessionTarget.sessionId,
          provider: "claude-cli",
          model: "opus",
          modelHasVision: false,
          sourceReplyDeliveryMode: "automatic",
          config,
          ...turn,
        });
        try {
          const grant = mintGrant.mock.lastCall![0].context;
          const { tools } = await resolveMcpLoopbackScopedTools({
            cfg: config,
            context: grant,
            admittedRunContext: context.params.admittedRunContext,
          });
          const current = {
            kind,
            names: tools.map((tool) => tool.name).toSorted(),
            binding: {
              sessionId: "native-parent-session",
              authEpoch: context.authEpoch,
              authEpochVersion: context.authEpochVersion,
              extraSystemPromptHash: context.extraSystemPromptHash,
              messageToolPolicyHash: context.messageToolPolicyHash,
              promptToolNamesHash: context.promptToolNamesHash,
              cwdHash: context.cwdHash,
              mcpConfigHash: context.preparedBackend.mcpConfigHash,
              mcpResumeHash: context.preparedBackend.mcpResumeHash,
            },
          };
          expect(current.binding.promptToolNamesHash).toBeTruthy();
          if (previous) {
            const { authEpochVersion, ...binding } = current.binding;
            const reuse = resolveCliSessionReuse({
              ...binding,
              authEpochVersion: authEpochVersion!,
              binding: previous.binding,
            });
            expect(
              { from: previous.kind, to: kind, reuse },
              JSON.stringify({
                added: current.names.filter((name) => !previous!.names.includes(name)),
                removed: previous.names.filter((name) => !current.names.includes(name)),
              }),
            ).toMatchObject({
              from: previous.kind,
              to: kind,
              // Prompt drift may resume with a note; only invalidation drops the context.
              reuse: { sessionId: "native-parent-session" },
            });
          }
          previous = current;
        } finally {
          await context.preparedBackend.cleanup?.();
        }
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

  it("keeps a completion tool-free when the caller disabled tools", async () => {
    const context = await fixture.prepare({
      ...completionRun(fixture.session.sessionTarget),
      disableTools: true,
    });
    try {
      expect(context.params.cliToolAvailability).toEqual({ native: [], openClaw: [] });
    } finally {
      await context.preparedBackend.cleanup?.();
    }
  });
});
