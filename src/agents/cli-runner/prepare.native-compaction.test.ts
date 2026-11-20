import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { McpLoopbackRequestContext } from "../../gateway/mcp-grant-store.js";
import {
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "../../gateway/mcp-http.runtime.js";
import type {
  CliBackendExecuteContext,
  CliBackendPlugin,
} from "../../plugins/cli-backend.types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
} from "../cli-runner.test-helpers.js";
import { executePreparedCliRun } from "./execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
} from "./execute.test-support.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

const { buildAnthropicCliBackend } = await loadBundledPluginFacade<{
  buildAnthropicCliBackend: () => CliBackendPlugin;
}>({ pluginId: "anthropic", artifactBasename: "api.js" });

const nativeSessionId = "8f0e7a52-5b8e-4f4e-9d47-3c1f0b9a2d61";
const sent: CliBackendExecuteContext[] = [];
const grantContexts: McpLoopbackRequestContext[] = [];
let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;

beforeEach(() => {
  sent.length = 0;
  grantContexts.length = 0;
  const backend = buildAnthropicCliBackend();
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [
      {
        ...backend,
        pluginId: "anthropic",
        config: { ...backend.config, command: process.execPath },
        // Only provider I/O is replaced; preparation and execution run their production paths.
        runtimeArtifact: undefined,
        prepareExecution: async (context) => ({
          ...(await backend.prepareExecution?.(context)),
          async *execute(input: CliBackendExecuteContext) {
            sent.push(input);
            yield { type: "result", subtype: "success", result: "ok", session_id: nativeSessionId };
          },
        }),
      },
    ],
  });
  setCliRunnerPrepareTestDeps({
    isWorkspaceBootstrapPending: async () => false,
    resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
    getActiveMcpLoopbackRuntime: () => ({
      port: 31783,
      ownerToken: "fixture-owner",
      nonOwnerToken: "fixture-reader",
    }),
    mintMcpLoopbackClientGrant: (grant: { context: McpLoopbackRequestContext }) => {
      grantContexts.push(grant.context);
      return createTestMcpLoopbackClientGrant(grant);
    },
    bindMcpLoopbackClientGrantAdmission: () => true,
    activateMcpLoopbackClientGrantCapture: () => ({ captureNativeToolAuthority: () => true }),
    revokeMcpLoopbackClientGrant: () => true,
    revokeMintedMcpLoopbackClientGrant: () => true,
    resolveMcpLoopbackPolicyTools,
    resolveMcpLoopbackScopedTools,
    resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
    getCliLiveSessionGeneration: () => undefined,
    loadManifestModelCatalog: () => [],
  });
  fixture = createCliRunnerPrepareFixture(prepareCliRunContext);
});

afterEach(async () => {
  await fixture.cleanup();
  resetCliRunnerPrepareTestDeps();
  cliBackendsTesting.resetDepsForTest();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

it.each([
  ["default tools", false],
  ["workspace-only tools with a managed native tool", true],
])(
  "manual compaction resends the turn's cached prefix without tool authority (%s)",
  async (_name, workspaceOnly) => {
    const { dir, sessionTarget } = fixture.session;
    vi.stubEnv("HOME", dir);
    const managedNativeTools = { default: ["Agent"] };
    const config: OpenClawConfig = {
      agents: { defaults: { workspace: dir } },
      session: { store: sessionTarget.storePath },
      plugins: workspaceOnly
        ? { enabled: false, entries: { anthropic: { config: { managedNativeTools } } } }
        : { enabled: false },
      tools: { allow: ["read"], ...(workspaceOnly ? { fs: { workspaceOnly: true } } : {}) },
    };
    setRuntimeConfigSnapshot(config);
    const run = async (overrides: Parameters<typeof fixture.prepare>[0]) => {
      const context = await fixture.prepare({
        config,
        sessionKey: sessionTarget.sessionKey,
        provider: "claude-cli",
        model: "opus",
        cliSessionId: nativeSessionId,
        cliSessionBinding: { sessionId: nativeSessionId },
        ...overrides,
      });
      try {
        await executePreparedCliRun(context, nativeSessionId);
      } finally {
        await context.preparedBackend.cleanup?.();
      }
    };
    // Only the reply pipeline knows inbound metadata; compaction must still send it.
    await run({ prompt: "follow-up", extraSystemPrompt: "TURN-ONLY-INBOUND-METADATA" });
    // Compaction runs as its own resumed process; read what that process receives.
    let compaction: { argv: string[]; systemPrompt: string } | undefined;
    supervisorSpawnMock.mockImplementationOnce(async (spawn) => {
      if (spawn.mode !== "child") {
        throw new Error("compaction must run as a child process");
      }
      const { argv } = spawn;
      const file = argv.indexOf("--system-prompt-file") + 1;
      compaction = { argv, systemPrompt: file ? fs.readFileSync(argv[file] ?? "", "utf8") : "" };
      const stdout = [
        { type: "system", subtype: "compact_boundary", session_id: nativeSessionId },
        { type: "result", result: "", session_id: nativeSessionId },
      ];
      return createManagedRun({
        ...createSuccessfulProcessExit(),
        stdout: stdout.map((record) => JSON.stringify(record)).join("\n"),
      });
    });
    await run({ prompt: "/compact", controlOperation: "compact" });

    const [turn] = sent;
    expect(turn?.systemPrompt).toContain("TURN-ONLY-INBOUND-METADATA");
    // Turns replace Claude Code's prompt with OpenClaw's; the compaction process must too.
    expect(compaction?.systemPrompt).toBe(turn?.systemPrompt);
    expect(compaction?.argv).not.toContain("--append-system-prompt-file");
    expect(compaction?.argv.at(-1)).toBe("/compact");
    expect(compaction?.argv).toEqual(expect.arrayContaining(["--resume", nativeSessionId]));
    const tools = (args: readonly string[]) => args[args.indexOf("--tools") + 1];
    expect(tools(compaction?.argv ?? [])).toBe(tools(turn?.args ?? []));
    expect(turn?.args).toContain("--disable-slash-commands");
    expect(compaction?.argv).not.toContain("--disable-slash-commands");
    expect(grantContexts.map((context) => context.toolCallsRefused)).toEqual([undefined, true]);
  },
);

const FORK_CHECKPOINT = "11111111-2222-3333-4444-555555555555";

it("a session fork branches the native session and runs only its own tools", async () => {
  const { dir, sessionTarget } = fixture.session;
  vi.stubEnv("HOME", dir);
  const config: OpenClawConfig = {
    agents: { defaults: { workspace: dir } },
    session: { store: sessionTarget.storePath },
    plugins: { enabled: false },
    tools: { allow: ["read", "ls", "exec"] },
  };
  setRuntimeConfigSnapshot(config);
  let fork: { argv: string[] } | undefined;
  supervisorSpawnMock.mockImplementationOnce(async (spawn) => {
    if (spawn.mode !== "child") {
      throw new Error("a fork must run as its own child process");
    }
    fork = { argv: spawn.argv };
    const stdout = [
      {
        type: "system",
        subtype: "init",
        session_id: "fork-successor",
        tools: ["mcp__openclaw__read"],
      },
      { type: "result", subtype: "success", result: "fork answer", session_id: "fork-successor" },
    ];
    return createManagedRun({
      ...createSuccessfulProcessExit(),
      stdout: stdout.map((record) => JSON.stringify(record)).join("\n"),
    });
  });
  const context = await fixture.prepare({
    config,
    sessionKey: sessionTarget.sessionKey,
    runtimePolicySessionKey: sessionTarget.sessionKey,
    provider: "claude-cli",
    model: "opus",
    prompt: "Improve the next prompt",
    controlOperation: "fork",
    cliSessionId: nativeSessionId,
    cliSessionBinding: { sessionId: nativeSessionId },
    forkCliSessionOnResume: true,
    cliSessionResumeAt: FORK_CHECKPOINT,
    toolCallsAllow: ["read"],
    disableCliLiveSession: true,
  });
  try {
    await expect(executePreparedCliRun(context, nativeSessionId)).resolves.toMatchObject({
      text: "fork answer",
      sessionId: "fork-successor",
    });
  } finally {
    await context.preparedBackend.cleanup?.();
  }

  expect(sent).toEqual([]);
  expect(fork?.argv).toEqual(
    expect.arrayContaining([
      "--resume",
      nativeSessionId,
      "--fork-session",
      "--resume-session-at",
      FORK_CHECKPOINT,
    ]),
  );
  // Claude's native execution tools stay off (only MCP discovery remains). The grant lists the
  // session's tools, so the resumed native session keeps its catalog, and runs only the fork's.
  const argv = fork?.argv ?? [];
  expect(argv[argv.indexOf("--tools") + 1]?.split(",")).toEqual(["ToolSearch"]);
  expect(grantContexts).toHaveLength(1);
  expect(grantContexts[0]?.toolsAllow).toEqual(expect.arrayContaining(["read", "ls", "exec"]));
  expect(grantContexts[0]?.toolCallsAllow).toEqual(["read"]);
  expect(grantContexts[0]?.toolCallsRefused).toBeUndefined();
});

it("a session fork refuses a native session from another auth profile", async () => {
  const { dir, sessionTarget } = fixture.session;
  vi.stubEnv("HOME", dir);
  const config: OpenClawConfig = {
    agents: { defaults: { workspace: dir } },
    session: { store: sessionTarget.storePath },
    plugins: { enabled: false },
  };
  setRuntimeConfigSnapshot(config);
  supervisorSpawnMock.mockClear();

  await expect(
    fixture.prepare({
      config,
      sessionKey: sessionTarget.sessionKey,
      provider: "claude-cli",
      model: "opus",
      prompt: "Improve the next prompt",
      controlOperation: "fork",
      cliSessionId: nativeSessionId,
      cliSessionBinding: { sessionId: nativeSessionId, authProfileId: "anthropic:other-account" },
      forkCliSessionOnResume: true,
      cliSessionResumeAt: FORK_CHECKPOINT,
      toolCallsAllow: [],
    }),
  ).rejects.toThrow("cannot fork this session: its native session is not reusable (auth-profile)");
  expect(supervisorSpawnMock).not.toHaveBeenCalled();
});
