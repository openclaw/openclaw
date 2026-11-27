import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginRuntimeMock,
  resetPluginRuntimeStateForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexSessionCatalogControl } from "../session-catalog-control.js";
import { CodexAppServerClient } from "./client.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config-runtime.js";
import type { CodexPluginConfig } from "./config.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { getCurrentSharedClientEntry } from "./shared-client-lifecycle.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import {
  createForkTestRuntime,
  forkControl,
  forkParams,
  forkResponse,
  codexForkTurn,
} from "./upstream-session-fork.test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

const boundaryMocks = vi.hoisted(() => ({ listTurns: vi.fn() }));
const linkMocks = vi.hoisted(() => ({ delete: vi.fn(), upsert: vi.fn() }));
const transcriptMocks = vi.hoisted(() => ({ importHistory: vi.fn() }));

const boundary = {
  beforeTurnId: "turn-2",
  lastRetainedTurnId: "turn-1",
} as const;

vi.mock("openclaw/plugin-sdk/session-catalog", async (importOriginal) => ({
  ...(await importOriginal()),
  deleteSessionUpstreamLinkAsync: linkMocks.delete,
  upsertSessionUpstreamLinkAsync: linkMocks.upsert,
}));

vi.mock("./transcript-mirror.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transcript-mirror.js")>()),
  importCodexThreadHistoryToTranscript: transcriptMocks.importHistory,
}));

vi.mock("./upstream-fork-boundary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./upstream-fork-boundary.js")>()),
  resolveCodexUpstreamForkBoundary: vi.fn(async () => ({
    ok: true,
    boundary,
    editorText: "edit me",
  })),
  listCodexUpstreamTurns: boundaryMocks.listTurns,
}));

import { forkCodexUpstreamSession } from "./upstream-session-fork.js";

let controls: ReturnType<typeof forkControl>;
let bindingStore: ReturnType<typeof createCodexTestBindingStore>;
let runtime: ReturnType<typeof createPluginRuntimeMock>;
function run(
  params: Parameters<typeof forkCodexUpstreamSession>[0] = forkParams(),
  overrides: Partial<Parameters<typeof forkCodexUpstreamSession>[1]> = {},
) {
  return forkCodexUpstreamSession(params, {
    bindingStore,
    runtime,
    controlFactory: controls.controlFactory,
    harnessRuntimeId: "codex",
    ...overrides,
  });
}

function sourceBinding(overrides: Partial<CodexAppServerThreadBinding> = {}) {
  return {
    threadId: "thread-canonical",
    connectionScope: "supervision",
    supervisionSourceThreadId: "thread-source",
    appServerRuntimeFingerprint: "fingerprint",
    preserveNativeModel: true,
    conversationSourceTransferComplete: true,
    cwd: "/tmp",
    model: "gpt-5.6-luna",
    modelProvider: "openai",
    ...overrides,
  } satisfies CodexAppServerThreadBinding;
}

let stateDir: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fork-owner-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  controls = forkControl();
  bindingStore = createCodexTestBindingStore();
  runtime = createPluginRuntimeMock();
  boundaryMocks.listTurns.mockReset();
  linkMocks.delete.mockReset();
  linkMocks.upsert.mockReset().mockReturnValue(true);
  transcriptMocks.importHistory.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  resetPluginRuntimeStateForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("forkCodexUpstreamSession", () => {
  it.each(["rpc-error", "invalid-response", "late-response"] as const)(
    "retires an uncertain fork connection without interrupting its peer (%s)",
    async (outcome) => {
      const forkWritten = createDeferred<{ id: number }>();
      const transports: ReturnType<typeof createClientHarness>[] = [];
      const archives: unknown[] = [];
      vi.spyOn(CodexAppServerClient, "start").mockImplementation(async () => {
        const transport = createClientHarness({
          onWrite: (line, send) => {
            const request = JSON.parse(line) as { id: number; method: string; params: unknown };
            if (request.method === "initialize") {
              send({
                id: request.id,
                result: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` },
              });
            } else if (request.method === "model/list" || request.method === "thread/list") {
              send({ id: request.id, result: { data: [] } });
            } else if (request.method === "thread/fork") {
              forkWritten.resolve(request);
            } else if (request.method === "thread/archive") {
              archives.push(request.params);
              send({ id: request.id, result: {} });
            } else if (request.method !== "initialized") {
              throw new Error(`Unexpected fork fixture request: ${request.method}`);
            }
          },
        });
        transports.push(transport);
        return transport.client;
      });
      const config = {
        agents: { entries: { main: { agentDir: stateDir, workspace: stateDir } } },
      };
      const pluginConfig = {
        appServer: {
          transport: "websocket",
          homeScope: "agent",
          url: `wss://fork-lifetime.example.test/${path.basename(stateDir)}`,
          authToken: "synthetic-fork-lifetime-token",
          requestTimeoutMs: 200,
        },
      } satisfies CodexPluginConfig;
      const controlFactory = createCodexSessionCatalogControl({
        getPluginConfig: () => pluginConfig,
        getRuntimeConfig: () => config,
        resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
        env: {},
      });
      const appServer = resolveCodexSupervisionAppServerRuntimeOptions({ pluginConfig, env: {} });
      const clientOptions = {
        agentDir: stateDir,
        config,
        startOptions: appServer.start,
        authProfileId: null,
      };
      const peer = await getLeasedSharedCodexAppServerClient(clientOptions);
      let peerReleased = false;
      let replacement: CodexAppServerClient | undefined;
      try {
        await peer.request("model/list", {});
        const close = vi.spyOn(peer, "close");
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
        await controlFactory.forRequest("main").initialize();
        const params = forkParams();
        params.upstream.ref.connectionFingerprint = buildCodexAppServerConnectionFingerprint(
          appServer,
          stateDir,
        );
        boundaryMocks.listTurns.mockResolvedValueOnce([codexForkTurn("turn-2", "edit me")]);
        const operation = run(params, { controlFactory });
        const request = await Promise.race([
          forkWritten.promise,
          operation.then(() => {
            throw new Error("Fork completed before the native request was written");
          }),
        ]);
        expect(getCurrentSharedClientEntry(peer)?.activeLeases).toBe(2);
        const transport = transports[0]!;
        if (outcome === "rpc-error") {
          transport.send({
            id: request.id,
            error: { code: -32603, message: "failed to read newly created fork" },
          });
        } else if (outcome === "invalid-response") {
          transport.send({ id: request.id, result: { thread: { id: "unverified-orphan" } } });
        } else {
          await vi.advanceTimersByTimeAsync(201);
        }
        await expect(operation).resolves.toMatchObject({
          status: "failed",
          code: "upstream-unavailable",
        });
        vi.useRealTimers();
        if (outcome === "late-response") {
          transport.send({ id: request.id, result: forkResponse("late-fork") });
        }
        expect(getCurrentSharedClientEntry(peer)).toBeUndefined();
        expect(close).not.toHaveBeenCalled();
        await expect(peer.request("model/list", {})).resolves.toEqual({ data: [] });
        replacement = await getLeasedSharedCodexAppServerClient(clientOptions);
        expect(replacement).not.toBe(peer);
        await expect(replacement.request("model/list", {})).resolves.toEqual({ data: [] });
        expect(runtime.agent.session.createSessionEntry).not.toHaveBeenCalled();
        expect(archives).toEqual([]);
        expect(releaseLeasedSharedCodexAppServerClient(peer)).toBe(true);
        peerReleased = true;
        expect(close).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
        if (!peerReleased) {
          releaseLeasedSharedCodexAppServerClient(peer);
        }
        if (replacement) {
          releaseLeasedSharedCodexAppServerClient(replacement);
        }
        await controlFactory.stop();
        await Promise.all(transports.map(({ client }) => client.closeAndWait()));
      }
    },
  );

  it.each([undefined, "required"] as const)(
    "imports the verified cut and links before binding (sandbox: %s)",
    async (sandbox) => {
      const retainedTurn = codexForkTurn("turn-1", "one");
      boundaryMocks.listTurns.mockResolvedValueOnce([retainedTurn]);
      const { archiveThread, control, forkThread } = controls;
      const events: string[] = [];
      linkMocks.upsert.mockImplementation(() => {
        events.push("link");
        return true;
      });
      const write = bindingStore.mutate.bind(bindingStore);
      const mutate = vi.spyOn(bindingStore, "mutate").mockImplementation(async (...args) => {
        events.push("bind");
        return await write(...args);
      });
      const forkRuntime = createForkTestRuntime(undefined, bindingStore, "codex-custom");
      const createSessionEntry = vi.mocked(forkRuntime.agent.session.createSessionEntry);

      const result = await run(
        { ...forkParams(), sandbox },
        {
          harnessRuntimeId: "codex-custom",
          resolveConfig: () => ({}),
          runtime: forkRuntime,
        },
      );

      expect(forkThread).toHaveBeenCalledWith(
        {
          threadId: "thread-source",
          beforeTurnId: "turn-2",
          excludeTurns: true,
          ...(sandbox ? { sandbox: "workspace-write" } : {}),
        },
        expect.any(Function),
      );
      expect(boundaryMocks.listTurns).toHaveBeenLastCalledWith(control, "thread-forked");
      expect(transcriptMocks.importHistory.mock.calls[0]?.[0]).toMatchObject({
        sessionKey: "agent:main:dashboard:forked",
        thread: { id: "thread-forked", turns: [retainedTurn] },
        throughTurnId: "turn-1",
      });
      expect(linkMocks.upsert.mock.calls[0]).toMatchObject([
        {
          marker: { turnId: "turn-1", userMessageCount: 1 },
          sessionKey: "agent:main:dashboard:forked",
          threadId: "thread-forked",
        },
        { ifAbsent: true },
      ]);
      expect(createSessionEntry.mock.calls[0]?.[0]).toMatchObject({
        initialEntry: { agentHarnessId: "codex-custom" },
      });
      expect(createSessionEntry.mock.calls[0]?.[0]).not.toHaveProperty(
        "recoverMatchingInitialEntry",
      );
      expect(events).toEqual(["link", "bind"]);
      expect(mutate.mock.calls[0]).toMatchObject([
        expect.anything(),
        {
          kind: "set",
          binding: {
            connectionScope: "supervision",
            supervisionSourceThreadId: "thread-forked",
            preserveNativeModel: true,
            pendingSupervisionBranch: {
              sourceThreadId: "thread-forked",
              connectionFingerprint: "fingerprint",
              lastTurnId: "turn-1",
            },
          },
        },
        expect.any(Function),
      ]);
      expect(result).toEqual({
        status: "created",
        key: "agent:main:dashboard:forked",
        editorText: "edit me",
      });
      expect(archiveThread).not.toHaveBeenCalled();
    },
  );

  it.each(["unknown home", "private connection drift", "private source drift"])(
    "fails closed on %s before reading or forking native history",
    async (scenario) => {
      const { forkThread } = controls;
      const params = forkParams();
      params.upstream.ref = {
        connectionFingerprint: scenario === "unknown home" ? "unknown-fingerprint" : "fingerprint",
        threadId: params.upstream.threadId,
      };

      vi.spyOn(bindingStore, "readAsync").mockResolvedValue(
        sourceBinding({
          supervisionSourceThreadId:
            scenario === "private source drift" ? "other-source" : "thread-source",
          appServerRuntimeFingerprint:
            scenario === "private connection drift" ? "other-connection" : "fingerprint",
        }),
      );
      await expect(run(params)).resolves.toEqual({
        status: "failed",
        code: "upstream-unavailable",
        message:
          "This Codex thread is not available on the current connection. Reconnect to its host and try again.",
      });

      expect(forkThread).not.toHaveBeenCalled();
      expect(boundaryMocks.listTurns).not.toHaveBeenCalled();
    },
  );

  it("archives a fork whose read-back history proves beforeTurnId was ignored", async () => {
    boundaryMocks.listTurns.mockResolvedValueOnce([
      codexForkTurn("turn-1", "one"),
      codexForkTurn("turn-2", "edit me"),
    ]);
    const { archiveThread, retireConnection } = controls;

    const result = await run();

    expect(result).toMatchObject({
      status: "failed",
      code: "upstream-unavailable",
      message: expect.stringContaining("Codex version"),
    });
    expect(archiveThread).toHaveBeenCalledWith("thread-forked", undefined);
    expect(retireConnection).not.toHaveBeenCalled();
    expect(runtime.agent.session.createSessionEntry).not.toHaveBeenCalled();
    expect(linkMocks.upsert).not.toHaveBeenCalled();
  });

  it.each(["thread-source", "thread-canonical"])(
    "rejects a fork response that reuses the original or canonical source id: %s",
    async (threadId) => {
      boundaryMocks.listTurns.mockResolvedValueOnce([codexForkTurn("turn-2", "edit me")]);
      controls = forkControl(vi.fn(async () => forkResponse(threadId)));
      const { archiveThread, retireConnection } = controls;
      vi.spyOn(bindingStore, "readAsync").mockResolvedValue(sourceBinding());
      const result = await run();

      expect(result).toMatchObject({ status: "failed", code: "upstream-unavailable" });
      expect(archiveThread).not.toHaveBeenCalled();
      expect(retireConnection).toHaveBeenCalledOnce();
    },
  );
});
