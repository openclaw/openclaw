import fs from "node:fs/promises";
import path from "node:path";
import type { CopilotClient } from "@github/copilot-sdk";
import type {
  AgentHarnessAttemptParamsV2,
  AgentHarnessV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { loadUserTurnTranscriptRecorderFactoryForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
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
              connection: options?.connection ?? sdk.RuntimeConnection.forStdio(),
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
  let harness: AgentHarnessV2 | undefined;
  plugin.register(
    createTestPluginApi({
      id: "copilot",
      name: "Copilot",
      source: "test",
      config: {},
      registrationMode: "full",
      runtime: { state: { openKeyedStore } } as never,
      registerAgentHarness: (registered) => {
        harness = registered as AgentHarnessV2;
      },
    }),
  );
  if (!harness) {
    throw new Error("Copilot harness was not registered");
  }
  const registered = harness;
  cleanups.push(async () => {
    await registered.dispose?.();
  });
  const manager = SessionManager.inMemory(directory);
  const params = {
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
  } as unknown as AgentHarnessAttemptParamsV2;
  const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
  const run = (overrides: Record<string, unknown> = {}) => {
    const attempt = { ...params, ...overrides };
    const recorder = createRecorder({ input: { text: attempt.prompt }, target: () => undefined });
    delete recorder.captureModelPromptProjection;
    attempt.userTurnTranscriptRecorder = recorder;
    return (async () => {
      const result = await registered.runAttempt(attempt);
      if (!("terminal" in result)) {
        throw new Error("Copilot must return a canonical attempt result");
      }
      return result;
    })();
  };
  return { directory, manager, openKeyedStore, run, registered };
}

function replyOk() {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-fixture",
      object: "chat.completion",
      created: 1,
      model: "fixture-model",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

it.each(["success", "failure", "cancel", "cleanup-failure"] as const)(
  "does not retain detached native history or touch bindings after %s",
  async (outcome) => {
    const { directory, manager, openKeyedStore, run } = await fixture();
    const requested = createDeferred<void>();
    const response = createDeferred<Response>();
    const controller = new AbortController();
    transport.reply = async () => {
      requested.resolve();
      return response.promise;
    };
    const pending = run({ sessionPersistence: "detached", abortSignal: controller.signal });
    await Promise.race([
      requested.promise,
      pending.then((result) => {
        throw new Error(
          `Attempt ended before provider request: ${JSON.stringify(result.terminal)} ${result.terminal.kind === "failed" ? String(result.terminal.error) : ""}`,
        );
      }),
    ]);
    const client = transport.clients[0]!;
    expect(transport.sessionId).toBeDefined();
    const nativePath = path.join(directory, "copilot", "session-state", transport.sessionId!);
    expect((await fs.readdir(nativePath)).length).toBeGreaterThan(0);
    const cleanupFailure = new Error("synthetic native deletion failure");
    if (outcome === "cleanup-failure") {
      vi.spyOn(client, "deleteSession").mockRejectedValueOnce(cleanupFailure);
    }
    if (outcome === "cancel") {
      controller.abort();
    }
    response.resolve(
      outcome === "failure"
        ? new Response(JSON.stringify({ error: { message: "synthetic provider failure" } }), {
            status: 400,
          })
        : replyOk(),
    );
    const result = await pending;
    expect(result.terminal.kind).toBe(
      outcome === "success" ? "ok" : outcome === "cancel" ? "aborted" : "failed",
    );
    if (outcome === "success") {
      expect(result.assistantTexts).toEqual(["OK"]);
      expect(
        manager.getEntries().filter((entry) => entry.type === "message").length,
      ).toBeGreaterThan(0);
    }
    expect(openKeyedStore).not.toHaveBeenCalled();
    if (outcome === "cleanup-failure") {
      expect(result.terminal).toMatchObject({ kind: "failed", error: cleanupFailure });
      expect((await client.listSessions()).map((entry) => entry.sessionId)).toEqual([
        transport.sessionId,
      ]);
      return;
    }
    expect(await client.listSessions()).toEqual([]);
    await expect(fs.stat(nativePath)).rejects.toMatchObject({ code: "ENOENT" });
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
  expect(
    (await fs.readdir(path.join(directory, "copilot", "session-state", native!.sessionId))).length,
  ).toBeGreaterThan(0);
  const second = await run({ runId: "fixture-turn-2", prompt: "Reply OK again" });
  expect(second.terminal.kind).toBe("ok");
  expect((await client.listSessions()).map((entry) => entry.sessionId)).toEqual([
    native!.sessionId,
  ]);
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
  expect((await client.listSessions()).map((entry) => entry.sessionId)).toEqual([
    native!.sessionId,
  ]);
  expect(lookup).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(await store.lookup("caller-owned-session")).toEqual(binding);
  expect(openKeyedStore).toHaveBeenCalledTimes(accesses);
});

it("captures and replays the installed setup runtime and rejects a different artifact", async () => {
  const { run, registered } = await fixture();
  transport.reply = async () => replyOk();
  const captured = await run({ sessionPersistence: "detached", captureRuntimeArtifact: true });
  expect(captured.terminal.kind).toBe("ok");
  expect(captured.runtimeArtifact).toMatchObject({
    id: expect.stringContaining("copilot-sdk:"),
    fingerprint: expect.any(String),
  });
  const artifact = captured.runtimeArtifact!;
  expect(await registered.runtimeArtifact!.validate(artifact)).toBe(true);
  const replayed = await run({ sessionPersistence: "detached", expectedRuntimeArtifact: artifact });
  expect(replayed.terminal.kind).toBe("ok");
  expect(replayed.runtimeArtifact).toEqual(artifact);
  const rejected = await run({
    sessionPersistence: "detached",
    expectedRuntimeArtifact: { ...artifact, fingerprint: "0".repeat(64) },
  });
  expect(rejected.terminal).toMatchObject({
    kind: "failed",
    error: { message: expect.stringContaining("verified runtime changed") },
  });
});
