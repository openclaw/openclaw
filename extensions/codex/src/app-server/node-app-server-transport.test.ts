import fs from "node:fs/promises";
import * as authRuntime from "openclaw/plugin-sdk/agent-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import { useCodexWorkerProvisioningFixture } from "../node-app-server-command.test-support.js";
import { startCodexAttemptThread } from "./attempt-startup.js";
import { createAttemptPaths, createAttemptParams } from "./attempt-startup.test-support.js";
import {
  claimCodexAppServerLiveThread,
  hasCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import { threadStartResult } from "./codex-app-server.test-fixtures.js";
import { resolveCodexAppServerRuntimeOptions, resolveCodexComputerUseConfig } from "./config.js";
import { createCodexWorkerClientFactory } from "./node-app-server-transport.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { releaseCodexProbeClient, type CodexAppServerClientFactory } from "./shared-client.js";
import { createCodexInferenceReadResponses } from "./test-support.js";

const provisionWorker = useCodexWorkerProvisioningFixture();

const tempRoots = new Set<string>();
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of tempRoots) {
    await fs.rm(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

async function connect(
  start?: (factory: CodexAppServerClientFactory) => Promise<CodexAppServerClient>,
) {
  const { configVersion } = provisionWorker();
  const closed = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  let receive: ((frame: Uint8Array) => void | Promise<void>) | undefined;
  const sent: Array<Record<string, unknown>> = [];
  const response = Promise.withResolvers<Record<string, unknown>>();
  const replies: Record<string, unknown> = {
    ...createCodexInferenceReadResponses(),
    "configRequirements/read": { requirements: null },
    "thread/start": threadStartResult("worker-thread", "/repo"),
  };
  let current = true;
  const runtime: Pick<PluginRuntime, "nodes"> = {
    nodes: {
      list: async () => {
        throw new Error("Unexpected discovery");
      },
      invoke: async () => {
        throw new Error("Unexpected unary invocation");
      },
      openDuplex: async () => ({
        send: async (frame) => {
          const request = JSON.parse(Buffer.from(frame).toString("utf8")) as Record<
            string,
            unknown
          >;
          sent.push(request);
          if (request.method === "initialize") {
            await receive?.(
              Buffer.from(
                JSON.stringify({ id: request.id, result: { userAgent: "codex-cli/0.164.0" } }),
              ),
            );
          } else if (typeof request.method === "string" && request.id !== undefined) {
            await receive?.(
              Buffer.from(
                JSON.stringify({
                  id: request.id,
                  result: replies[request.method] ?? { ok: true },
                }),
              ),
            );
          } else if (request.id === "worker-refresh") {
            response.resolve(request);
          }
        },
        onMessage: (listener) => {
          receive = listener;
          return () => {
            receive = undefined;
          };
        },
        close: () => {
          closing.resolve();
          if (start) {
            closed.resolve();
          }
        },
        closed: closed.promise,
      }),
    },
  };
  const open = vi.spyOn(runtime.nodes, "openDuplex");
  const sandbox = {
    ...createSandboxTestContext(),
    placementExecutionMode: "remote-exec",
    placementNodeId: "node",
    placementEnvironmentId: "environment",
    placementSessionId: "session",
    placementOwnerEpoch: 1,
  };
  const factory = createCodexWorkerClientFactory({
    runtime,
    permissionMode: "full",
    sandbox,
    signal: new AbortController().signal,
    assertCurrent: () => {
      if (!current) {
        throw new Error("Retired worker authority");
      }
    },
  });
  const client = await (start ? start(factory) : factory());
  return {
    client,
    response: response.promise,
    configVersion,
    factory,
    closed,
    closing,
    sent,
    open,
    retire: () => {
      current = false;
    },
    deliver: async (value: unknown) => receive?.(Buffer.from(JSON.stringify(value))),
  };
}

it("uses the versioned placement duplex and joins caller-owned probe shutdown", async () => {
  const fixture = await connect();
  expect(fixture.open.mock.calls[0]?.[0]).toMatchObject({
    command: "codex.app-server.stdio.v1." + fixture.configVersion,
    nodeId: "node",
    params: {
      authorization: "session-full",
      placement: { environmentId: "environment", sessionId: "session", ownerEpoch: 1 },
    },
  });
  expect(await fixture.client.request("thread/read", { threadId: "thread" })).toEqual({ ok: true });
  let settled = false;
  const cleanup = releaseCodexProbeClient(fixture.client, fixture.factory, true).then(() => {
    settled = true;
  });
  await fixture.closing.promise;
  expect(settled).toBe(false);
  fixture.closed.resolve();
  await cleanup;
  expect(settled).toBe(true);
});

it.each(["native", "disconnect"] as const)("distinguishes %s from caller closure", async (mode) => {
  const fixture = await connect();
  if (mode === "native") {
    await fixture.deliver({
      method: "openclaw/process/exited",
      params: { code: 23, signal: null },
    });
  }
  fixture.closed.resolve();
  await fixture.closing.promise;
  expect(fixture.client.getCloseError()?.message).toContain(
    mode === "native" ? "exited" : "disconnected",
  );
  await fixture.client.closeAndWait();
});

it("rejects request effects after the admitted owner retires", async () => {
  const fixture = await connect();
  fixture.retire();
  const request = fixture.client.request("turn/start", { threadId: "thread" });
  await fixture.closing.promise;
  await expect(request).rejects.toThrow();
  expect(fixture.sent.some((message) => message.method === "turn/start")).toBe(false);
  let settled = false;
  const cleanup = releaseCodexProbeClient(fixture.client, fixture.factory, true).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  fixture.closed.resolve();
  await cleanup;
  expect(settled).toBe(true);
});

// Factory-only proof misses the late attempt initializer installing host auth.
it("keeps worker refresh outside host auth after attempt startup without losing thread custody", async () => {
  const paths = createAttemptPaths(tempRoots);
  const readHostProfiles = vi.fn(
    () =>
      ({
        "openai:decoy": {
          type: "oauth",
          provider: "openai",
          accountId: "gateway-account",
          access: "gateway-access-decoy",
          refresh: "gateway-refresh-decoy",
          expires: Date.now() + 60_000,
        },
      }) satisfies authRuntime.AuthProfileStore["profiles"],
  );
  const refreshHost = vi
    .spyOn(authRuntime, "refreshOAuthCredentialForRuntime")
    .mockRejectedValue(new Error("Unexpected Gateway OAuth refresh"));
  const readHostStore = vi
    .spyOn(authRuntime, "ensureAuthProfileStoreAsync")
    .mockRejectedValue(new Error("Unexpected Gateway auth store load"));
  const attemptParams = createAttemptParams(paths);
  attemptParams.authProfileStore = {
    version: 1,
    get profiles() {
      return readHostProfiles();
    },
  };
  const pluginConfig = { appServer: { command: "codex" } };
  let attempt: Awaited<ReturnType<typeof startCodexAttemptThread>> | undefined;
  const fixture = await connect(async (factory) => {
    attempt = await startCodexAttemptThread({
      bindingStore: createCodexTestBindingStore(),
      attemptClientFactory: factory,
      callerOwnedAttemptClient: true,
      appServer: resolveCodexAppServerRuntimeOptions({ pluginConfig }),
      pluginConfig,
      computerUseConfig: resolveCodexComputerUseConfig({ pluginConfig }),
      clientOptions: { authProfileId: null },
      startupAuthAccountCacheKey: undefined,
      startupEnvApiKeyCacheKey: undefined,
      agentDir: paths.agentDir,
      config: undefined,
      buildAttemptParams: () => attemptParams,
      sessionAgentId: "agent-1",
      effectiveWorkspace: paths.workspaceDir,
      effectiveCwd: paths.cwd,
      dynamicTools: [],
      webSearchAllowed: false,
      developerInstructions: undefined,
      bundleMcpThreadConfig: {
        configPatch: undefined,
        diagnostics: [],
        evaluated: false,
        fingerprint: undefined,
        staticServerNames: [],
        userStaticServerNames: [],
      },
      nativeToolSurfaceEnabled: true,
      nativeProviderWebSearchSupport: "supported",
      sandboxExecServerEnabled: false,
      sandbox: null,
      contextEngineProjection: undefined,
      startupTimeoutMs: 5_000,
      signal: new AbortController().signal,
      onStartupTimeout: () => undefined,
      spawnedBy: undefined,
    });
    return attempt.client;
  });
  try {
    const ownership = await claimCodexAppServerLiveThread(fixture.client, "worker-thread");
    expect(ownership).toBeDefined();
    expect(
      await retainCodexAppServerLiveThread(fixture.client, "worker-thread", ownership?.release),
    ).toBe(true);
    expect(hasCodexAppServerLiveThread(fixture.client, "worker-thread")).toBe(true);
    await fixture.deliver({
      id: "worker-refresh",
      method: "account/chatgptAuthTokens/refresh",
      params: {},
    });
    const response = await fixture.response;
    expect.soft(readHostProfiles).not.toHaveBeenCalled();
    expect.soft(readHostStore).not.toHaveBeenCalled();
    expect.soft(refreshHost).not.toHaveBeenCalled();
    expect.soft(response).toMatchObject({
      error: {
        code: -32603,
        message: "ChatGPT token refresh requires an OpenClaw-owned auth profile.",
      },
    });
    expect.soft(response.result).toBeUndefined();
    expect.soft(JSON.stringify(response)).not.toContain("gateway-access-decoy");
    await ownership?.release("worker-thread");
    expect(hasCodexAppServerLiveThread(fixture.client, "worker-thread")).toBe(false);
    expect(fixture.sent).toContainEqual(
      expect.objectContaining({
        method: "thread/unsubscribe",
        params: { threadId: "worker-thread" },
      }),
    );
  } finally {
    attempt?.turnRoute.release();
    attempt?.releaseSharedClientLease();
    fixture.closed.resolve();
    await fixture.client.closeAndWait();
  }
});
