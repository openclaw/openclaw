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
