import fs from "node:fs/promises";
import { beforeEach, vi } from "vitest";
import { buildAnthropicCliBackend } from "../../extensions/anthropic/test-api.js";
import { buildGoogleGeminiCliBackend } from "../../extensions/google/test-api.js";
import { buildOpenAICodexCliBackend } from "../../extensions/openai/test-api.js";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { setCliRunnerExecuteTestDeps } from "./cli-runner/execute.js";
import { setCliRunnerPrepareTestDeps } from "./cli-runner/prepare.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

export const supervisorSpawnMock = vi.fn();
export const enqueueSystemEventMock = vi.fn();
export const requestHeartbeatNowMock = vi.fn();
export const SMALL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

const hoisted = vi.hoisted(() => {
  type BootstrapContext = {
    bootstrapFiles: WorkspaceBootstrapFile[];
    contextFiles: EmbeddedContextFile[];
  };

  return {
    resolveBootstrapContextForRunMock: vi.fn<() => Promise<BootstrapContext>>(async () => ({
      bootstrapFiles: [],
      contextFiles: [],
    })),
  };
});

setCliRunnerExecuteTestDeps({
  getProcessSupervisor: () => ({
    spawn: (...args: unknown[]) => supervisorSpawnMock(...args),
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    reconcileOrphans: vi.fn(),
    getRecord: vi.fn(),
  }),
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
  requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
});

setCliRunnerPrepareTestDeps({
  makeBootstrapWarn: () => () => {},
  resolveBootstrapContextForRun: hoisted.resolveBootstrapContextForRunMock,
});

type MockRunExit = {
  reason:
    | "manual-cancel"
    | "overall-timeout"
    | "no-output-timeout"
    | "spawn-error"
    | "signal"
    | "exit";
  exitCode: number | null;
  exitSignal: NodeJS.Signals | number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  noOutputTimedOut: boolean;
};

type TestCliBackendConfig = {
  command: string;
  env?: Record<string, string>;
  clearEnv?: string[];
};

export function createManagedRun(exit: MockRunExit, pid = 1234) {
  return {
    runId: "run-supervisor",
    pid,
    startedAtMs: Date.now(),
    stdin: undefined,
    wait: vi.fn().mockResolvedValue(exit),
    cancel: vi.fn(),
  };
}

export function mockSuccessfulCliRun() {
  supervisorSpawnMock.mockResolvedValueOnce(
    createManagedRun({
      reason: "exit",
      exitCode: 0,
      exitSignal: null,
      durationMs: 50,
      stdout: "ok",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    }),
  );
}

export const EXISTING_CODEX_CONFIG = {
  agents: {
    defaults: {
      cliBackends: {
        "codex-cli": {
          command: "codex",
          args: ["exec", "--json"],
          resumeArgs: ["exec", "resume", "{sessionId}", "--json"],
          output: "text",
          modelArg: "--model",
          sessionMode: "existing",
        },
      },
    },
  },
} satisfies OpenClawConfig;

export async function setupCliRunnerTestModule() {
  const registry = createEmptyPluginRegistry();
  registry.cliBackends = [
    {
      pluginId: "anthropic",
      backend: buildAnthropicCliBackend(),
      source: "test",
    },
    {
      pluginId: "openai",
      backend: buildOpenAICodexCliBackend(),
      source: "test",
    },
    {
      pluginId: "google",
      backend: buildGoogleGeminiCliBackend(),
      source: "test",
    },
  ];
  setActivePluginRegistry(registry);
  supervisorSpawnMock.mockClear();
  enqueueSystemEventMock.mockClear();
  requestHeartbeatNowMock.mockClear();
  hoisted.resolveBootstrapContextForRunMock.mockReset().mockResolvedValue({
    bootstrapFiles: [],
    contextFiles: [],
  });
  return (await import("./cli-runner.js")).runCliAgent;
}

export async function setupClaudeCliRunnerTestModule() {
  const runCliAgent = await setupCliRunnerTestModule();
  return (params: Parameters<typeof import("./claude-cli-runner.js").runClaudeCliAgent>[0]) =>
    runCliAgent({
      ...params,
      provider: params.provider ?? "claude-cli",
    });
}

export function stubBootstrapContext(params: {
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
}) {
  hoisted.resolveBootstrapContextForRunMock.mockResolvedValueOnce(params);
}

export async function runCliAgentWithBackendConfig(params: {
  runCliAgent: typeof import("./cli-runner.js").runCliAgent;
  backend: TestCliBackendConfig;
  runId: string;
}) {
  await params.runCliAgent({
    sessionId: "s1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp",
    config: {
      agents: {
        defaults: {
          cliBackends: {
            "codex-cli": params.backend,
          },
        },
      },
    } satisfies OpenClawConfig,
    prompt: "hi",
    provider: "codex-cli",
    model: "gpt-5.2-codex",
    timeoutMs: 1_000,
    runId: params.runId,
    cliSessionId: "thread-123",
  });
}

export async function runExistingCodexCliAgent(params: {
  runCliAgent: typeof import("./cli-runner.js").runCliAgent;
  runId: string;
  cliSessionBindingAuthProfileId: string;
  authProfileId: string;
}) {
  await params.runCliAgent({
    sessionId: "s1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp",
    config: EXISTING_CODEX_CONFIG,
    prompt: "hi",
    provider: "codex-cli",
    model: "gpt-5.4",
    timeoutMs: 1_000,
    runId: params.runId,
    cliSessionBinding: {
      sessionId: "thread-123",
      authProfileId: params.cliSessionBindingAuthProfileId,
    },
    authProfileId: params.authProfileId,
  });
}

export async function withTempImageFile(
  prefix: string,
): Promise<{ tempDir: string; sourceImage: string }> {
  const os = await import("node:os");
  const path = await import("node:path");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const sourceImage = path.join(tempDir, "image.png");
  await fs.writeFile(sourceImage, Buffer.from(SMALL_PNG_BASE64, "base64"));
  return { tempDir, sourceImage };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});
