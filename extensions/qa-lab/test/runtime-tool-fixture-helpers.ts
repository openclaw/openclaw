import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { createQaBusState } from "../src/bus-state.js";
import { createQaChannelTransport } from "../src/qa-channel-transport.js";
import { runRuntimeToolFixture } from "../src/runtime-tool-fixture.js";
import type { QaSuiteRuntimeEnv } from "../src/suite-runtime-types.js";

const tempRoots: string[] = [];

async function makeEnv(overrides: Partial<QaSuiteRuntimeEnv> = {}): Promise<QaSuiteRuntimeEnv> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-tool-fixture-"));
  const workspaceDir = path.join(tempRoot, "workspace");
  await fs.mkdir(workspaceDir);
  tempRoots.push(tempRoot);
  return {
    outputDir: tempRoot,
    repoRoot: tempRoot,
    providerMode: "mock-openai",
    primaryModel: "openai/gpt-5.6-luna",
    alternateModel: "openai/gpt-5.6-luna",
    mock: null,
    cfg: {},
    transport: createQaChannelTransport(createQaBusState()),
    gateway: {
      baseUrl: "http://127.0.0.1:1",
      tempRoot,
      workspaceDir,
      runtimeEnv: {},
      call: vi.fn(),
    },
    ...overrides,
  };
}

type RuntimeToolFixtureConfig = Parameters<typeof runRuntimeToolFixture>[1];
type RuntimeToolFixtureDeps = Parameters<typeof runRuntimeToolFixture>[2];

const MOCK_BASE_URL = "http://127.0.0.1:9999";

function runtimeToolFixtureConfig(
  toolName: string,
  overrides: RuntimeToolFixtureConfig = {},
): RuntimeToolFixtureConfig {
  return {
    toolName,
    toolCoverage: {
      bucket: "openclaw-dynamic-integration",
      expectedLayer: "openclaw-dynamic",
    },
    ...overrides,
  };
}

function runtimeToolFixtureDeps(
  params: {
    tools?: Iterable<string>;
    fetchJson?: RuntimeToolFixtureDeps["fetchJson"];
    runAgentPrompt?: RuntimeToolFixtureDeps["runAgentPrompt"];
  } = {},
): RuntimeToolFixtureDeps {
  return {
    createSession: vi.fn(async (_env, _label, key) => key!),
    readEffectiveTools: vi.fn(async () => new Set(params.tools)),
    runAgentPrompt: params.runAgentPrompt ?? vi.fn(async () => ({})),
    fetchJson: params.fetchJson ?? vi.fn(),
    ensureImageGenerationConfigured: vi.fn(),
  };
}

function mockRequestLog(requests: Array<Record<string, unknown>>) {
  return vi.fn().mockResolvedValueOnce({ cursor: 0 }).mockResolvedValueOnce(requests);
}

function mockToolRequests(params: {
  toolName?: string;
  happyArgs?: Record<string, unknown>;
  happyOutput?: string;
  failureArgs?: Record<string, unknown>;
  failureOutput?: string;
  happyCallId?: string;
  happyOutputCallId?: string;
  failureCallId?: string;
  failureOutputCallId?: string;
  omitHappyOutput?: boolean;
  omitFailureOutput?: boolean;
}) {
  const toolName = params.toolName ?? "read";
  const happyCallId = params.happyCallId ?? `call-${toolName}-happy`;
  const failureCallId = params.failureCallId ?? `call-${toolName}-failure`;
  return [
    {
      allInputText: `target=${toolName}`,
      plannedToolCallId: happyCallId,
      plannedToolName: toolName,
      plannedToolArgs: params.happyArgs ?? { path: "README.md" },
    },
    ...(params.omitHappyOutput
      ? []
      : [
          {
            allInputText: `target=${toolName}`,
            toolOutputCallId: params.happyOutputCallId ?? happyCallId,
            toolOutput: params.happyOutput ?? "README contents",
          },
        ]),
    {
      allInputText: `failure target=${toolName}`,
      plannedToolCallId: failureCallId,
      plannedToolName: toolName,
      plannedToolArgs: params.failureArgs ?? { path: "/missing" },
    },
    ...(params.omitFailureOutput
      ? []
      : [
          {
            allInputText: `failure target=${toolName}`,
            toolOutputCallId: params.failureOutputCallId ?? failureCallId,
            toolOutput: params.failureOutput ?? "ENOENT: no such file or directory",
          },
        ]),
  ];
}

async function runMockRuntimeToolFixture(params: {
  env?: QaSuiteRuntimeEnv;
  toolName?: string;
  requests: Array<Record<string, unknown>>;
  config?: RuntimeToolFixtureConfig;
  tools?: Iterable<string>;
  runAgentPrompt?: RuntimeToolFixtureDeps["runAgentPrompt"];
  forceCodex?: boolean;
}) {
  const toolName = params.toolName ?? "read";
  const env = params.env ?? (await makeEnv({ mock: { baseUrl: MOCK_BASE_URL } }));
  if (params.forceCodex) {
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
  }
  return runRuntimeToolFixture(
    env,
    runtimeToolFixtureConfig(toolName, {
      promptSnippet: `target=${toolName}`,
      failurePromptSnippet: `failure target=${toolName}`,
      ...params.config,
    }),
    runtimeToolFixtureDeps({
      tools: params.tools ?? [toolName],
      fetchJson: mockRequestLog(params.requests),
      runAgentPrompt: params.runAgentPrompt,
    }),
  );
}

export async function cleanupRuntimeToolFixtureTempRoots() {
  await Promise.all(
    tempRoots.splice(0).map((tempRoot) => fs.rm(tempRoot, { recursive: true, force: true })),
  );
}

export {
  makeEnv,
  MOCK_BASE_URL,
  mockToolRequests,
  runMockRuntimeToolFixture,
  runtimeToolFixtureConfig,
  runtimeToolFixtureDeps,
};
export type { RuntimeToolFixtureConfig, RuntimeToolFixtureDeps };
