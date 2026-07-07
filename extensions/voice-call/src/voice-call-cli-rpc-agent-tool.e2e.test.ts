// Voice Call E2E tests cover CLI, Gateway RPC, and agent tool through the mock provider.
import fs from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { testing as voiceCallCliTesting } from "./cli.js";
import {
  createVoiceCallStateRuntimeForTests,
  createTestStorePath,
  installVoiceCallStateRuntimeForTests,
} from "./manager.test-harness.js";
import { clearVoiceCallStateRuntime } from "./runtime-state.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

type GatewayHandler = (request: {
  params?: Record<string, unknown>;
  respond: (ok: boolean, payload?: unknown, error?: { message?: string }) => void;
}) => Promise<void>;

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function reserveLocalPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve local voice-call port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function isAddressInUseError(error: unknown): boolean {
  return error instanceof Error && `${error.message}\n${error.stack ?? ""}`.includes("EADDRINUSE");
}

const tempDirs = new Set<string>();

async function runVoiceCallEntryPointFixture(): Promise<void> {
  const stateDir = createTestStorePath();
  tempDirs.add(stateDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  resetPluginStateStoreForTests();
  installVoiceCallStateRuntimeForTests();
  const stateRuntime = createVoiceCallStateRuntimeForTests();
  const config = createVoiceCallBaseConfig({ provider: "mock" });
  config.maxConcurrentCalls = 3;
  config.store = path.join(stateDir, "voice-calls");
  config.serve.port = await reserveLocalPort();

  const methods = new Map<string, GatewayHandler>();
  const tools: Array<{
    name: string;
    execute: (toolCallId: string, params: unknown) => Promise<{ details?: unknown }>;
  }> = [];
  let cliRegistrar: ((context: { program: Command }) => void) | undefined;
  let service:
    | {
        stop?: (context: { config: unknown; stateDir: string; logger: unknown }) => Promise<void>;
      }
    | undefined;
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const api = createTestPluginApi({
    id: "voice-call",
    name: "Voice Call",
    source: "qa",
    config: {},
    pluginConfig: config,
    logger,
    runtime: {
      agent: {},
      state: stateRuntime,
      tts: { textToSpeechTelephony: vi.fn() },
    } as unknown as OpenClawPluginApi["runtime"],
    registerGatewayMethod: (method, handler) => {
      methods.set(method, handler as GatewayHandler);
    },
    registerTool: (tool) => {
      tools.push(tool as (typeof tools)[number]);
    },
    registerCli: (registrar) => {
      cliRegistrar = registrar as typeof cliRegistrar;
    },
    registerService: (registeredService) => {
      service = registeredService as typeof service;
    },
  });
  plugin.register(api);

  const invokeGateway = async (
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const handler = methods.get(method);
    if (!handler) {
      throw new Error(`missing Gateway handler: ${method}`);
    }
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      void handler({
        params,
        respond(ok, payload, error) {
          if (ok) {
            const record = asOptionalRecord(payload);
            if (!record) {
              reject(new Error(`${method} returned a non-object payload`));
              return;
            }
            resolve(record);
            return;
          }
          reject(new Error(error?.message ?? `${method} failed`));
        },
      }).catch(reject);
    });
  };

  voiceCallCliTesting.setCallGatewayFromCliForTests(async (method, _options, params) =>
    invokeGateway(method, asOptionalRecord(params)),
  );
  const program = new Command();
  cliRegistrar?.({ program });
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  try {
    await program.parseAsync(
      ["voicecall", "start", "--to", "+15550001111", "--message", "CLI fixture"],
      { from: "user" },
    );

    const rpcResult = await invokeGateway("voicecall.initiate", {
      to: "+15550002222",
      message: "RPC fixture",
      mode: "notify",
    });
    expect(rpcResult).toMatchObject({ initiated: true, callId: expect.any(String) });

    const voiceCallTool = tools.find((tool) => tool.name === "voice_call");
    if (!voiceCallTool) {
      throw new Error("voice_call tool was not registered");
    }
    const toolResult = await voiceCallTool.execute("tool-call", {
      action: "initiate_call",
      to: "+15550003333",
      message: "Agent tool fixture",
      mode: "conversation",
    });
    expect(toolResult.details).toMatchObject({ initiated: true, callId: expect.any(String) });

    const status = (await invokeGateway("voicecall.status")) as { calls?: unknown[] };
    expect(status.calls).toHaveLength(3);
    expect(stdout).toHaveBeenCalled();
  } finally {
    await service?.stop?.({ config: {}, stateDir, logger }).catch(() => undefined);
    voiceCallCliTesting.setCallGatewayFromCliForTests();
    clearVoiceCallStateRuntime();
    resetPluginStateStoreForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
}

describe("QA Voice Call CLI, RPC, and agent tool", () => {
  afterEach(() => {
    voiceCallCliTesting.setCallGatewayFromCliForTests();
    clearVoiceCallStateRuntime();
    resetPluginStateStoreForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
    tempDirs.clear();
  });

  it("routes all three entry points through one mock-provider runtime", async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await runVoiceCallEntryPointFixture();
        return;
      } catch (error) {
        lastError = error;
        if (!isAddressInUseError(error)) {
          throw error;
        }
      }
    }
    throw lastError;
  });
});
