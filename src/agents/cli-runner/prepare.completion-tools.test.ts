import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { mintMcpLoopbackClientGrant as MintMcpLoopbackClientGrant } from "../../gateway/mcp-grant-store.js";
import {
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "../../gateway/mcp-http.runtime.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServerConfig,
} from "../cli-runner.test-helpers.js";
import * as subagentSpawn from "../subagents/spawn/subagent-spawn.js";
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
    fixture = createCliRunnerPrepareFixture((params) =>
      prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params }),
    );
  });

  afterEach(async () => {
    await fixture.settle();
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
  });

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

  it("mediates trusted completion tools with persisted requester policy", async () => {
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
        inheritedToolAllow: ["read", "exec", "write"],
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
    const context = await fixture.prepare({
      sessionKey: sessionTarget.sessionKey,
      sessionId: sessionTarget.sessionId,
      provider: "claude-cli",
      model: "opus",
      modelHasVision: false,
      sourceReplyDeliveryMode: "automatic",
      trustedInternalHandoff,
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "subagent_announce",
        sourceSessionKey: childSessionKey,
      },
      config: {
        session: { store: sessionTarget.storePath },
        tools: {
          toolsBySender: { "*": { deny: ["group:runtime", "group:fs"] } },
        },
        mcp: { servers: { userProbe: { command: "node", args: ["user-probe.mjs"] } } },
      },
    });
    try {
      const grant = mintGrant.mock.calls[0]?.[0]?.context;
      expect(grant).toBeDefined();
      expect(context.params.cliToolAvailability?.native).toEqual([]);
      expect(grant?.toolsAllow).toEqual(expect.arrayContaining(["read", "exec"]));
      expect(grant?.toolsAllow).toEqual(context.params.cliToolAvailability?.openClaw);
      for (const denied of inheritedToolDeny) {
        expect(grant?.toolsAllow).not.toContain(denied);
      }
      expect(grant?.trustedInternalHandoff).toEqual(trustedInternalHandoff);
      expect(grant?.toolsAllow?.toSorted()).toEqual(["exec", "read"]);
      const args = context.preparedBackend.backend.args ?? [];
      const mcpConfigPath = args[args.indexOf("--mcp-config") + 1];
      const bundle = JSON.parse(fs.readFileSync(mcpConfigPath ?? "", "utf-8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(Object.keys(bundle.mcpServers)).toEqual(["openclaw"]);
    } finally {
      await context.preparedBackend.cleanup?.();
    }
  });

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
