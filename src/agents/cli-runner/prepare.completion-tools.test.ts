import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
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

describe("trusted completion tool preparation", () => {
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
