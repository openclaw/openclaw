import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServer,
  createTestMcpLoopbackServerConfig,
} from "../cli-runner.test-helpers.js";
import { createJsonlStdinBackendConfig } from "./prepare-mcp.test-support.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
let ensureMcpLoopbackServer: ReturnType<typeof vi.fn>;

function setClaudeCliBackend(bundleMcp: boolean) {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        pluginId: "anthropic",
        modelProvider: "anthropic",
        bundleMcp,
        ...(bundleMcp ? { bundleMcpMode: "claude-config-file" as const } : {}),
        config: {
          ...createJsonlStdinBackendConfig("claude"),
          systemPromptFileArg: "--append-system-prompt-file",
          systemPromptWhen: "always",
          resumeArgs: ["--resume", "{sessionId}"],
          sessionMode: "existing",
        },
      },
    ],
  });
}

beforeEach(() => {
  ensureMcpLoopbackServer = vi.fn(createTestMcpLoopbackServer);
  setCliRunnerPrepareTestDeps({
    isWorkspaceBootstrapPending: async () => false,
    resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
    resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
    loadManifestModelCatalog: () => [],
    getActiveMcpLoopbackRuntime: vi.fn(() => undefined),
    ensureMcpLoopbackServer,
    createMcpLoopbackServerConfig: vi.fn(createTestMcpLoopbackServerConfig),
    mintMcpLoopbackClientGrant: vi.fn(createTestMcpLoopbackClientGrant),
  });
  fixture = createCliRunnerPrepareFixture((params) => {
    setRuntimeConfigSnapshot(params.config ?? {});
    return prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params });
  });
});

afterEach(async () => {
  await fixture.cleanup();
  resetCliRunnerPrepareTestDeps();
  cliBackendsTesting.resetDepsForTest();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

it.each([
  { kind: "main", sessionKey: "agent:main:main" },
  { kind: "channel", sessionKey: "agent:main:telegram:direct:42" },
  { kind: "cron", sessionKey: "agent:main:cron:nightly" },
  { kind: "subagent", sessionKey: "agent:main:subagent:child-1" },
])(
  "places a $kind session's Claude CLI run on the node from tools.exec.claudeCliHost",
  async ({ sessionKey }) => {
    setClaudeCliBackend(true);
    const context = await fixture.prepare({
      sessionKey,
      provider: "claude-cli",
      model: "opus",
      config: { tools: { exec: { claudeCliHost: "node", node: "node-a" } } },
      sessionEntry: { sessionId: "session-test", updatedAt: 0 },
    });

    expect(context.executionTarget).toEqual({ kind: "node", placement: { nodeId: "node-a" } });
    expect(context.params.sessionEntry).toMatchObject({ execHost: "node", execNode: "node-a" });
    expect(ensureMcpLoopbackServer).not.toHaveBeenCalled();
    await context.preparedBackend.cleanup?.();
  },
);

it("keeps Claude CLI on the Gateway without tools.exec.claudeCliHost", async () => {
  setClaudeCliBackend(false);
  const sessionEntry = { sessionId: "session-test", updatedAt: 0 };
  const context = await fixture.prepare({
    provider: "claude-cli",
    model: "opus",
    config: { tools: { exec: { host: "node", node: "node-a" } } },
    sessionEntry,
  });

  expect(context.executionTarget.kind).not.toBe("node");
  expect(context.params.sessionEntry).toEqual(sessionEntry);
  await context.preparedBackend.cleanup?.();
});

it("refuses a Claude CLI run that tools.exec.claudeCliHost cannot place", async () => {
  setClaudeCliBackend(true);
  const prepare = (config: OpenClawConfig, execNode?: string) =>
    fixture.prepare({
      provider: "claude-cli",
      model: "opus",
      config,
      sessionEntry: { sessionId: "session-test", updatedAt: 0, execHost: "node", execNode },
    });

  await expect(prepare({ tools: { exec: { claudeCliHost: "node" } } }, "node-a")).rejects.toThrow(
    "tools.exec.node is not set",
  );
  await expect(
    prepare({ tools: { exec: { claudeCliHost: "node", node: "node-a" } } }, "node-b"),
  ).rejects.toThrow('This session is bound to node "node-b"');
  expect(ensureMcpLoopbackServer).not.toHaveBeenCalled();
});
