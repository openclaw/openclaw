import fs from "node:fs/promises";
import path from "node:path";
import type { CopilotClient } from "@github/copilot-sdk";
import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi, type TestPluginApiInput } from "openclaw/plugin-sdk/plugin-test-api";
import {
  loadUserTurnTranscriptRecorderFactoryForTest,
  runInHarnessToolAuthorityForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, expect, it, vi } from "vitest";
import { asAttemptParams } from "./harness.test-support.js";
import plugin from "./index.js";
import { awaitAttemptStage, createAttemptGate } from "./src/attempt.test-support.js";
import { createCopilotTestHostCapabilities } from "./src/host-capability.test-support.js";

const transport = vi.hoisted(() => ({
  reply: undefined as ((request: Request, signal: AbortSignal) => Promise<Response>) | undefined,
  clients: [] as CopilotClient[],
  sessionId: undefined as string | undefined,
}));

// Only provider I/O is synthetic. The registered harness, pool, SDK stdio runtime,
// native session files and worker-backed binding store are real.
vi.mock("./src/sdk-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./src/sdk-loader.js")>();
  return {
    ...actual,
    loadCopilotSdk: async () => {
      const sdk = await import("@github/copilot-sdk");
      class FixtureTransport extends sdk.CopilotRequestHandler {
        protected override async sendRequest(
          request: Request,
          context: { signal: AbortSignal; sessionId?: string },
        ) {
          if (!transport.reply) {
            throw new Error("No synthetic provider response configured");
          }
          transport.sessionId = context.sessionId;
          return transport.reply(request, context.signal);
        }
      }
      return {
        ...sdk,
        CopilotClient: class extends sdk.CopilotClient {
          constructor(options: ConstructorParameters<typeof CopilotClient>[0]) {
            super({
              ...options,
              connection: sdk.RuntimeConnection.forStdio(),
              mode: "empty",
              requestHandler: new FixtureTransport(),
            });
            transport.clients.push(this);
          }
        },
      };
    },
  };
});

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  transport.clients = [];
  transport.reply = undefined;
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

async function fixture() {
  const state = await createOpenClawTestState({ label: "copilot-detached" });
  const directory = state.root;
  cleanups.push(state.cleanup);
  setRuntimeConfigSnapshot({});
  const openKeyedStore = vi.fn((options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests("copilot", { ...options, env: state.env }),
  );
  const registerAgentHarness = vi.fn<NonNullable<TestPluginApiInput["registerAgentHarness"]>>();
  plugin.register(
    createTestPluginApi({
      id: "copilot",
      runtime: { state: { openKeyedStore } } as never,
      registerAgentHarness,
    }),
  );
  const registered = registerAgentHarness.mock.calls[0]![0] as AgentHarnessV2;
  cleanups.push(async () => registered.dispose?.());
  const manager = SessionManager.inMemory(directory);
  const params = asAttemptParams({
    agentId: "main",
    agentDir: directory,
    workspaceDir: directory,
    sessionId: "caller-owned-session",
    sessionKey: "agent:main:memory:fixture",
    sessionFile: "in-memory:fixture",
    sessionManager: manager,
    trigger: "memory",
    runId: "fixture-turn",
    prompt: "Reply OK",
    provider: "fixture-provider",
    modelId: "fixture-model",
    model: {
      id: "fixture-model",
      provider: "fixture-provider",
      api: "openai-completions",
      baseUrl: "https://example.com/v1",
      contextWindow: 16384,
      maxTokens: 512,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    resolvedApiKey: "synthetic-provider-key",
    authProfileId: "fixture-provider:synthetic",
    hostCapabilities: createCopilotTestHostCapabilities(() => []),
    disableTools: true,
    promptMode: "none",
    timeoutMs: 5000,
  });
  const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
  const run = (overrides: Record<string, unknown> = {}) => {
    const attempt = { ...params, ...overrides };
    const recorder = createRecorder({ input: { text: attempt.prompt }, target: () => undefined });
    delete recorder.captureModelPromptProjection;
    delete recorder.prepareModelPromptProjection;
    attempt.userTurnTranscriptRecorder = recorder;
    return runInHarnessToolAuthorityForTest(attempt, "copilot", async (admitted) => {
      const result = await registered.runAttempt(admitted);
      if (!("terminal" in result)) {
        throw new Error("Copilot must return a canonical attempt result");
      }
      return result;
    });
  };
  return { directory, manager, openKeyedStore, run };
}

function replyOk() {
  return Response.json({
    id: "chatcmpl-fixture",
    object: "chat.completion",
    created: 1,
    model: "fixture-model",
    choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

const nativePath = (directory: string, sessionId: string) =>
  path.join(directory, "copilot", "session-state", sessionId);
const sessionIds = async (client: CopilotClient) =>
  (await client.listSessions()).map((entry) => entry.sessionId);

it.each(["success", "failure", "cancel", "cleanup-failure"] as const)(
  "does not retain detached native history or touch bindings after %s",
  async (outcome) => {
    const { directory, manager, openKeyedStore, run } = await fixture();
    const response = createAttemptGate<Response>();
    const controller = new AbortController();
    transport.reply = response.wait;
    const pending = run({ sessionPersistence: "detached", abortSignal: controller.signal });
    await awaitAttemptStage(response.entered, pending);
    const client = transport.clients[0]!;
    expect(transport.sessionId).toBeDefined();
    const sessionPath = nativePath(directory, transport.sessionId!);
    expect((await fs.readdir(sessionPath)).length).toBeGreaterThan(0);
    const cleanupFailure = new Error("synthetic native deletion failure");
    if (outcome === "cleanup-failure") {
      vi.spyOn(client, "deleteSession").mockRejectedValueOnce(cleanupFailure);
    }
    if (outcome === "cancel") {
      controller.abort();
    }
    response.release(
      outcome === "failure"
        ? Response.json({ error: { message: "synthetic provider failure" } }, { status: 400 })
        : replyOk(),
    );
    const result = await pending;
    expect(result.terminal.kind).toBe(
      outcome === "success" ? "ok" : outcome === "cancel" ? "aborted" : "failed",
    );
    if (outcome === "success") {
      expect(result.assistantTexts).toEqual(["OK"]);
      expect(manager.getEntries().some((entry) => entry.type === "message")).toBe(true);
    }
    expect(openKeyedStore).not.toHaveBeenCalled();
    if (outcome === "cleanup-failure") {
      expect(result.terminal).toMatchObject({ kind: "failed", error: cleanupFailure });
      expect(await sessionIds(client)).toEqual([transport.sessionId]);
      return;
    }
    expect(await client.listSessions()).toEqual([]);
    await expect(fs.stat(sessionPath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("keeps caller-owned memory conversations resumable without marking them detached", async () => {
  const { directory, openKeyedStore, run } = await fixture();
  transport.reply = async () => replyOk();
  const first = await run();
  expect(first.terminal.kind).toBe("ok");
  const client = transport.clients[0]!;
  const [native] = await client.listSessions();
  expect(native).toBeDefined();
  const store = openKeyedStore.mock.results[0]!.value;
  expect(await store.lookup("caller-owned-session")).toMatchObject({
    sdkSessionId: native!.sessionId,
  });
  expect((await fs.readdir(nativePath(directory, native!.sessionId))).length).toBeGreaterThan(0);
  const second = await run({ runId: "fixture-turn-2", prompt: "Reply OK again" });
  expect(second.terminal.kind).toBe("ok");
  expect(await sessionIds(client)).toEqual([native!.sessionId]);
  const binding = await store.lookup("caller-owned-session");
  const accesses = openKeyedStore.mock.calls.length;
  const lookup = vi.spyOn(store, "lookup");
  const register = vi.spyOn(store, "register");
  const remove = vi.spyOn(store, "delete");
  const detached = await run({
    runId: "one-shot",
    sessionPersistence: "detached",
    initialReplayState: { sdkSessionId: native!.sessionId, journalValidated: true },
  });
  expect(detached.terminal.kind).toBe("ok");
  expect(transport.sessionId).not.toBe(native!.sessionId);
  expect(await sessionIds(client)).toEqual([native!.sessionId]);
  expect(lookup).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(await store.lookup("caller-owned-session")).toEqual(binding);
  expect(openKeyedStore).toHaveBeenCalledTimes(accesses);
});
