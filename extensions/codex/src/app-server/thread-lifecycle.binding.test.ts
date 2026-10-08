// Codex tests cover thread lifecycle.binding plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { patchSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import { resumeThread } from "../command-handler-bindings.js";
import { resolveCodexCommandDeps } from "../command-handler-deps.js";
import {
  claimCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { CodexAppServerClient, CodexAppServerRpcError } from "./client.js";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import { acquireCodexNativeConfigFence } from "./native-config-fence.js";
import { resolveCodexNativeSkillIsolation } from "./native-skill-isolation.js";
import type {
  CodexDynamicToolFunctionSpec,
  JsonObject,
  JsonValue,
  RpcRequest,
} from "./protocol.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createParams as createRunAttemptParams,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import type { PluginAppPolicyContext } from "./session-binding-record-codec.js";
import {
  createCodexTestBindingStore,
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding as writeRawCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { retireCodexAppServerSessionGeneration } from "./session-retirement.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  resolveCodexNativeConfigFenceKey,
  retainSharedCodexAppServerClientIfCurrent,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import { fingerprintEnvironmentSelection } from "./thread-fingerprints.js";
import { registerThreadPolicyRefreshTests } from "./thread-lifecycle-policy-refresh.test-support.js";
import { registerRequiredRootThreadPolicyTests } from "./thread-lifecycle-rooted.test-support.js";
import { startOrResumeThread as startOrResumeThreadImpl } from "./thread-lifecycle-run.js";
import {
  createLeasedCodexLifecycleHarness,
  startOrResumeAttemptThreadWithoutSkills as startOrResumeAttemptThread,
  twoStartsThenResumeMethods,
  type CodexAttemptThreadInput as LifecycleInput,
} from "./thread-lifecycle.test-fixtures.js";
import {
  releaseCodexAppServerBindingSubscription,
  withCodexAppServerThreadMutation,
} from "./thread-ownership.js";
import { CodexIncognitoPolicyChangeError } from "./thread-policy.js";
import { buildThreadResumeParams } from "./thread-requests.js";

function createLifecycleRequest(
  respond: (method: string, requestParams?: unknown) => Promise<unknown>,
) {
  return vi.fn((method: string, requestParams?: unknown) => {
    if (method === "config/read") {
      return Promise.resolve({ config: {}, origins: {}, layers: [] });
    }
    if (method === "configRequirements/read") {
      return Promise.resolve({ requirements: null });
    }
    return respond(method, requestParams);
  });
}

function createFixedThreadRequest(threadId: string, methods: string[]) {
  return createLifecycleRequest(async (method) => {
    if (methods.includes(method)) {
      return threadStartResult(threadId);
    }
    throw new Error(`unexpected method: ${method}`);
  });
}

const PREFLIGHT_METHODS = ["config/read", "configRequirements/read"];
const COLD_RESUME_METHODS = [
  ...PREFLIGHT_METHODS,
  "thread/read",
  "thread/resume",
  "thread/inject_items",
];
const WARM_RESUME_METHODS = [
  ...PREFLIGHT_METHODS,
  "thread/start",
  ...PREFLIGHT_METHODS,
  "thread/read",
  "thread/unsubscribe",
  "thread/resume",
  "thread/inject_items",
];
const START_THEN_RESUME_METHODS = [
  ...PREFLIGHT_METHODS,
  "thread/start",
  "thread/unsubscribe",
  ...COLD_RESUME_METHODS,
];

function createSequentialLifecycleHarness(
  resume: (requestParams?: unknown) => ReturnType<typeof threadStartResult>,
  effectiveConfig: JsonObject = {},
  origins: Record<string, JsonObject> = {},
) {
  let starts = 0;
  return createLeasedCodexLifecycleHarness({
    agentDir: path.join(tempDir, "agent"),
    respond: async (method: string, requestParams?: unknown) => {
      if (method === "config/read") {
        return { config: effectiveConfig, origins, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start") {
        starts += 1;
        return threadStartResult(`thread-${starts}`);
      }
      if (method === "thread/resume") {
        return resume(requestParams);
      }
      throw new Error(`unexpected method: ${method}`);
    },
  });
}

function startOrResumeThread(input: Pick<LifecycleInput, "client"> & Partial<LifecycleInput>) {
  const cwd = input.cwd ?? input.params?.workspaceDir ?? path.join(tempDir, "workspace");
  const params = input.params ?? createParams(path.join(tempDir, "session.jsonl"), cwd);
  return startOrResumeAttemptThread({
    signal: new AbortController().signal,
    dynamicTools: [],
    appServer: createThreadLifecycleAppServerOptions(),
    ...input,
    params,
    cwd,
  });
}

function retainThread(
  client: LifecycleInput["client"],
  binding: Awaited<ReturnType<typeof startOrResumeThread>>,
) {
  return retainCodexAppServerLiveThread(
    client,
    binding.threadId,
    undefined,
    binding.liveThreadConfigFingerprint,
  );
}

function disabledMcpServerStatus(name: string) {
  return {
    name,
    serverInfo: null,
    tools: {},
    resources: [],
    resourceTemplates: [],
    authStatus: "unsupported",
  };
}

function createThreadLifecycleAppServerOptions(): LifecycleInput["appServer"] {
  return {
    start: {
      transport: "stdio",
      command: "codex",
      args: ["app-server"],
      headers: {},
    },
    requestTimeoutMs: 60_000,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    codeModeOnly: false,
    loopDetectionPreToolUseRelay: true,
    connectionClass: "local-loopback",
  };
}

function createNetworkProxyThreadLifecycleAppServerOptions() {
  const configPatch = {
    "features.network_proxy.enabled": true,
    default_permissions: "openclaw-network",
    permissions: {
      "openclaw-network": {
        filesystem: {
          ":minimal": "read",
          ":project_roots": {
            ".": "write",
          },
        },
        network: {
          enabled: true,
          domains: {
            "api.openai.com": "allow",
          },
          proxy_url: "http://127.0.0.1:3128",
        },
      },
    },
  };
  return {
    ...createThreadLifecycleAppServerOptions(),
    networkProxy: {
      profileName: "openclaw-network",
      configFingerprint: "test-network-proxy",
      configPatch,
    },
  };
}

function createPaths() {
  return {
    sessionFile: path.join(tempDir, "session.jsonl"),
    workspaceDir: path.join(tempDir, "workspace"),
  };
}

function createParams(sessionFile: string, workspaceDir: string) {
  const params = createRunAttemptParams(sessionFile, workspaceDir);
  params.disableTools = false;
  params.config = undefined;
  return params;
}

const DEFAULT_CODEX_RUNTIME_THREAD_CONFIG = {
  project_doc_max_bytes: 131_072,
  "features.goals": false,
  "tools.update_plan.enabled": false,
  "features.code_mode": true,
  "features.code_mode_only": false,
  "features.shell_tool": true,
  "features.apply_patch_streaming_events": true,
  suppress_unstable_features_warning: true,
  "features.standalone_web_search": false,
  web_search: "cached",
} as const;

const DEFAULT_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT = JSON.stringify({
  "features.standalone_web_search": false,
  web_search: "cached",
});

function writeCodexAppServerBinding(...args: Parameters<typeof writeRawCodexAppServerBinding>) {
  const [sessionFile, binding] = args;
  registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
  return writeRawCodexAppServerBinding(sessionFile, {
    webSearchThreadConfigFingerprint: DEFAULT_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
    ...binding,
  });
}

function createMessageDynamicTool(
  description: string,
  actions: string[] = ["send"],
): CodexDynamicToolFunctionSpec {
  return {
    type: "function",
    name: "message",
    description,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: actions,
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };
}

function createNamedDynamicTool(name: string): CodexDynamicToolFunctionSpec {
  return {
    type: "function",
    name,
    description: `${name} test tool`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
}

function createDeferredNamedDynamicTool(name: string): LifecycleInput["dynamicTools"][number] {
  return {
    type: "namespace",
    name: "openclaw",
    description: "",
    tools: [{ ...createNamedDynamicTool(name), deferLoading: true }],
  };
}

function createPluginAppConfigPatch(options: { approvalsReviewer?: "user" } = {}) {
  return {
    apps: {
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
      "google-calendar-app": {
        enabled: true,
        destructive_enabled: true,
        open_world_enabled: true,
        default_tools_approval_mode: "auto",
        ...(options.approvalsReviewer ? { approvals_reviewer: options.approvalsReviewer } : {}),
      },
    },
  };
}

function createPluginAppPolicyContext() {
  return {
    fingerprint: "plugin-policy-1",
    apps: {
      "google-calendar-app": {
        configKey: "google-calendar",
        marketplaceName: "openai-curated" as const,
        pluginName: "google-calendar",
        allowDestructiveActions: true,
        mcpServerNames: ["google-calendar"],
      },
    },
    pluginAppIds: {
      "google-calendar": ["google-calendar-app"],
    },
  };
}

async function createManualResumeFixture(
  options: {
    active?: boolean;
    cold?: boolean;
    receipt?: "none" | "stale" | "unrelated";
    dynamicTools?: CodexDynamicToolFunctionSpec[];
    recordedTools?: JsonValue;
    missingMetadata?: boolean;
    omitCatalog?: boolean;
    wireClient?: boolean;
  } = {},
) {
  const dynamicTools = options.dynamicTools ?? [];
  vi.stubEnv("HOME", tempDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "isolated-state"));
  const sessionFile = path.join(tempDir, "manual-resume-session.jsonl");
  const workspaceDir = path.join(tempDir, "manual-resume-workspace");
  const agentDir = path.join(tempDir, "agent");
  const threadId = "thread-manual-resume";
  const rolloutPath = path.join(agentDir, "codex-home", "sessions", `rollout-${threadId}.jsonl`);
  await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
  await fs.writeFile(
    rolloutPath,
    `${JSON.stringify({ type: "session_meta", payload: { id: threadId, ...(options.omitCatalog ? {} : { dynamic_tools: options.recordedTools ?? dynamicTools }) } })}\n`,
  );
  if (options.missingMetadata) {
    await fs.rm(rolloutPath);
  }
  const response = threadStartResult(threadId, { cwd: workspaceDir });
  const thread = { ...response.thread, path: rolloutPath };
  let resumes = 0;
  const harness = createFakeCodexAppServerClient(async (method: string) => {
    if (method === "config/read") {
      return { config: {}, origins: {}, layers: [] };
    }
    if (method === "configRequirements/read") {
      return { requirements: null };
    }
    if (method === "skills/list") {
      return { data: [{ cwd: workspaceDir, errors: [], skills: [] }] };
    }
    if (method === "thread/read") {
      if (options.receipt === "stale") {
        await harness.notify({
          method: "thread/status/changed",
          params: { threadId, status: { type: "notLoaded" } },
        });
      }
      return {
        thread: {
          ...thread,
          status: options.active
            ? { type: "active", activeFlags: [] }
            : { type: options.cold ? "notLoaded" : "idle" },
        },
      };
    }
    if (method === "thread/unsubscribe") {
      return { status: "unsubscribed" };
    }
    if (method === "thread/resume") {
      if (resumes++ > 0 && options.receipt !== "none" && options.receipt !== "stale") {
        await harness.notify({
          method: "thread/status/changed",
          params: {
            threadId: options.receipt === "unrelated" ? "other-thread" : threadId,
            status: { type: "notLoaded" },
          },
        });
      }
      return { ...response, thread };
    }
    if (method === "thread/inject_items") {
      return {};
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const wire = options.wireClient ? createClientHarness() : undefined;
  const client = wire?.client ?? harness.client;
  if (wire) {
    // Keep the existing native response fixture behind the real wire client so
    // its async request guard and synchronous write edge remain under test.
    const appendWrites = wire.writes.push.bind(wire.writes);
    vi.spyOn(wire.writes, "push").mockImplementation((...messages) => {
      const count = appendWrites(...messages);
      for (const message of messages) {
        const request = JSON.parse(message) as RpcRequest;
        void Promise.resolve(harness.request(request.method, request.params)).then(
          (result) => wire.send({ id: request.id, result }),
          (error: unknown) =>
            wire.send({
              id: request.id,
              error: { code: -32603, message: String(error) },
            }),
        );
      }
      return count;
    });
    vi.spyOn(harness, "notify").mockImplementation(async (notification) => {
      wire.send(notification);
    });
    vi.spyOn(client, "initialize").mockResolvedValue(undefined);
  } else {
    Object.assign(client, {
      initialize: async () => undefined,
      // This fake closes and exits together; notify the pool's physical-client registry too.
      addTransportExitHandler: client.addCloseHandler.bind(client),
      setThreadSessionRequestGuard: () => undefined,
      close: () => harness.close(),
    });
  }
  const start = vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(client);
  try {
    await getLeasedSharedCodexAppServerClient({
      startOptions: { ...createThreadLifecycleAppServerOptions().start, command: process.execPath },
      authProfileId: null,
      agentDir,
      config: {},
    });
  } finally {
    start.mockRestore();
  }
  const params = { ...createParams(sessionFile, workspaceDir), agentDir };
  registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);
  const attach = () =>
    resumeThread(
      resolveCodexCommandDeps({
        bindingStore: testCodexAppServerBindingStore,
        codexControlRequest: async (_pluginConfig, method, requestParams, requestOptions) => {
          await requestOptions?.beforeRequest?.(
            <T>({
              method: preflightMethod,
              requestParams: preflightParams,
            }: {
              method: string;
              requestParams?: unknown;
            }) => client.request<T>(preflightMethod, preflightParams, { timeoutMs: 60_000 }),
            client,
            { assertCurrent: () => undefined },
          );
          const result = await client.request<JsonValue>(method, requestParams, {
            timeoutMs: 60_000,
          });
          await requestOptions?.onResponse?.(result, client, {
            authProfileId: undefined,
            assertCurrent: () => undefined,
          });
          return result;
        },
      }),
      {
        channel: "test",
        isAuthorizedSender: true,
        senderIsOwner: true,
        commandBody: `/codex resume ${threadId}`,
        config: {},
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile,
        requestConversationBinding: async () => ({ status: "error", message: "unused" }),
        detachConversationBinding: async () => ({ removed: false }),
        getCurrentConversationBinding: async () => null,
      },
      undefined,
      [threadId],
    );
  await attach();
  const common = {
    client,
    params,
    cwd: workspaceDir,
    dynamicTools,
    appServer: createThreadLifecycleAppServerOptions(),
    userMcpServersEnabled: false,
  };
  return {
    ...harness,
    attach,
    client,
    wire,
    close: () => {
      releaseLeasedSharedCodexAppServerClient(client);
      if (wire) {
        wire.client.close();
      } else {
        harness.close();
      }
    },
    common,
    sessionFile,
    threadId,
    identity: {
      kind: "session" as const,
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    },
    start: (overrides: Partial<Parameters<typeof startOrResumeThread>[0]> = {}) =>
      startOrResumeThread({ ...common, ...overrides }),
  };
}

setupRunAttemptTestHooks({ isolateNativeSkillHome: true });

async function createLeasedLifecycleWireClient(
  agentDir: string,
  respond: (request: RpcRequest) => unknown,
  transport: "stdio" | "websocket" | "unix" | "proxy" = "stdio",
) {
  const wire = createClientHarness();
  const appendWrites = wire.writes.push.bind(wire.writes);
  vi.spyOn(wire.writes, "push").mockImplementation((...messages) => {
    const count = appendWrites(...messages);
    for (const message of messages) {
      const request = JSON.parse(message) as RpcRequest;
      void Promise.resolve()
        .then(() => respond(request))
        .then(
          (result) => wire.send({ id: request.id, result }),
          (error: unknown) =>
            wire.send({
              id: request.id,
              error:
                error instanceof CodexAppServerRpcError
                  ? { code: error.code, message: error.message }
                  : { code: -32603, message: String(error) },
            }),
        );
    }
    return count;
  });
  vi.spyOn(wire.client, "initialize").mockResolvedValue(undefined);
  const start = vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(wire.client);
  try {
    await getLeasedSharedCodexAppServerClient({
      startOptions: {
        ...createThreadLifecycleAppServerOptions().start,
        command: process.execPath,
        transport: transport === "proxy" ? "stdio" : transport,
        args: transport === "proxy" ? ["app-server", "proxy"] : ["app-server"],
        ...(transport === "websocket" ? { url: "ws://127.0.0.1:8123" } : {}),
        ...(transport === "unix" ? { url: "unix:///tmp/synthetic-codex.sock" } : {}),
      },
      authProfileId: null,
      agentDir,
      config: {},
    });
  } finally {
    start.mockRestore();
  }
  // Preserve the wire harness's live transport getters.
  return Object.assign(wire, {
    start: (sessionFile: string, workspaceDir: string) =>
      startOrResumeThread({
        client: wire.client,
        params: { ...createParams(sessionFile, workspaceDir), agentDir },
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        userMcpServersEnabled: false,
        signal: new AbortController().signal,
      }),
  });
}

describe("Codex app-server thread lifecycle bindings", () => {
  registerRequiredRootThreadPolicyTests({
    createParams,
    createPaths,
    createThreadLifecycleAppServerOptions,
    startOrResumeThread,
  });
  it("inherits the effective native project-document budget", async () => {
    const { sessionFile, workspaceDir } = createPaths();
    const fixture = await createSequentialLifecycleHarness(
      () => threadStartResult("thread-1"),
      {
        project_doc_max_bytes: 200_000,
      },
      {
        project_doc_max_bytes: {
          name: { type: "user", file: "/codex/config.toml", profile: null },
          version: "sha256:authored-budget",
        },
      },
    );

    await startOrResumeThread({
      client: fixture.client,
      params: createParams(sessionFile, workspaceDir),
    });

    expect(
      fixture.request.mock.calls.find(([method]) => method === "thread/start")?.[1],
    ).toMatchObject({ config: { project_doc_max_bytes: 200_000 } });
  });

  it("rejects a host-only rotation after recovering the predecessor before the lifecycle lease", async () => {
    const workspaceDir = path.join(tempDir, "recovered-workspace");
    const params = createParams(path.join(tempDir, "recovered.jsonl"), workspaceDir);
    const current = {
      kind: "session" as const,
      agentId: "main",
      sessionKey: params.sessionKey!,
      sessionId: params.sessionId,
    };
    const previous = { ...current, sessionId: "before-compaction" };
    const scope = {
      agentId: current.agentId,
      sessionKey: current.sessionKey,
      storePath: path.join(tempDir, "admitted", "sessions.json"),
    };
    params.sessionTarget = { ...scope, sessionId: current.sessionId };
    await upsertSessionEntry({ ...scope, entry: { sessionId: previous.sessionId, updatedAt: 1 } });
    await patchSessionEntry({ ...scope, update: () => ({ sessionId: current.sessionId }) });
    const native = threadStartResult("recovered-native-thread");
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond: async (method) => {
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/resume") {
          return native;
        }
        throw new Error(`unexpected method: ${method}`);
      },
    });
    fixture.seed(native, { loaded: true, subscribed: false });
    const bindingStore = createCodexTestBindingStore();
    const binding = {
      threadId: native.thread.id,
      cwd: workspaceDir,
      preserveNativeModel: true as const,
      model: native.model,
      modelProvider: native.modelProvider,
      webSearchThreadConfigFingerprint: DEFAULT_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
    };
    await bindingStore.mutate(previous, { kind: "set", binding });
    const withLease = bindingStore.withLease.bind(bindingStore);
    vi.spyOn(bindingStore, "withLease").mockImplementationOnce(async (identity, run) => {
      expect(bindingStore.read(current)).toEqual(binding);
      await patchSessionEntry({ ...scope, update: () => ({ sessionId: "next-compaction" }) });
      return withLease(identity, run);
    });

    await expect(
      startOrResumeThreadImpl({
        client: fixture.client,
        params,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        userMcpServersEnabled: false,
        signal: new AbortController().signal,
        bindingStore,
      }),
    ).rejects.toThrow("Codex session generation is no longer current");
    expect(fixture.request.mock.calls.some(([method]) => method === "thread/resume")).toBe(false);
    expect(bindingStore.read(current)).toEqual(binding);
  });

  it("resumes idle A with current policy while B stays active and catalog leases come and go", async () => {
    const sessionFile = path.join(tempDir, "parallel-policy.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const threadId = "parallel-policy-a";
    const siblingId = "parallel-policy-b";
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond: async (method) => {
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/resume") {
          const reader = await getLeasedSharedCodexAppServerClient(fixture.acquireOptions);
          try {
            await reader.request("thread/read", { threadId: siblingId, includeTurns: false });
          } finally {
            releaseLeasedSharedCodexAppServerClient(reader);
          }
          return threadStartResult(threadId);
        }
        throw new Error(`unexpected method: ${method}`);
      },
    });
    fixture.seed(threadStartResult(threadId), { loaded: true, subscribed: false });
    const siblingResponse = threadStartResult(siblingId);
    fixture.seed(
      {
        ...siblingResponse,
        thread: { ...siblingResponse.thread, status: { type: "active", activeFlags: [] } },
      },
      { loaded: true, subscribed: true },
    );
    await writeCodexAppServerBinding(sessionFile, {
      threadId,
      cwd: workspaceDir,
    });
    const params = createParams(sessionFile, workspaceDir);
    const sibling = await getLeasedSharedCodexAppServerClient(fixture.acquireOptions);
    const siblingClaim = await claimCodexAppServerLiveThread(sibling, siblingId);
    try {
      const resumed = await startOrResumeThread({
        client: fixture.client,
        params,
        userMcpServersEnabled: false,
        developerInstructions: "current A policy",
      });
      expect(resumed).toMatchObject({ threadId, lifecycle: { action: "resumed" } });
      const binding = await readCodexAppServerBinding(sessionFile);
      expect(binding?.threadId).toBe(threadId);
      expect(binding?.preserveNativeModel).toBeUndefined();
      const injection = fixture.request.mock.calls.find(
        ([method]) => method === "thread/inject_items",
      );
      expect(JSON.stringify(injection?.[1])).toContain("current A policy");
      expect(siblingClaim).toBeDefined();
      expect(() => siblingClaim!.assertCurrent()).not.toThrow();
      await expect(
        sibling.request("thread/read", { threadId: siblingId, includeTurns: false }),
      ).resolves.toMatchObject({ thread: { status: { type: "active" } } });
      expect(fixture.request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
      expect(fixture.client.getCloseError()).toBeUndefined();
    } finally {
      await siblingClaim?.release(siblingId);
      releaseLeasedSharedCodexAppServerClient(sibling);
    }
  });

  registerThreadPolicyRefreshTests({
    createParams,
    createThreadLifecycleAppServerOptions,
    createLeasedLifecycleWireClient,
    startOrResumeThread,
    writeCodexAppServerBinding,
  });

  it.each([
    { incognito: false, stage: "plugin config", revocation: "host" },
    { incognito: true, stage: "app attestation", revocation: "thread/closed" },
  ])(
    "refuses revoked warm ownership during $stage ($revocation, incognito: $incognito)",
    async ({ incognito, stage, revocation }) => {
      const sessionFile = path.join(tempDir, "warm-revocation.jsonl");
      const workspaceDir = path.join(tempDir, "warm-revocation-workspace");
      const params = createParams(sessionFile, workspaceDir);
      if (incognito) {
        params.sessionKey = "agent:main:dashboard:incognito-warm-revocation";
      }
      const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
      const entered = createDeferred<void>();
      const proceed = createDeferred<void>();
      let warming = false;
      const pause = async (currentStage: string) => {
        if (warming && stage === currentStage) {
          entered.resolve();
          await proceed.promise;
        }
      };
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond: async (method) => {
          if (method === "config/read") {
            return { config: {}, origins: {}, layers: [] };
          }
          if (method === "configRequirements/read") {
            return { requirements: null };
          }
          if (method === "thread/start") {
            return threadStartResult("warm-revoked");
          }
          if (method === "app/installed") {
            await pause("app attestation");
            return { apps: [{ id: "fixture-app", enabled: true, callable: true }] };
          }
          throw new Error(`unexpected method: ${method}`);
        },
      });
      const { client, request } = fixture;
      const abandonClient = vi.fn(async () => {});
      const common = {
        client,
        params,
        userMcpServersEnabled: false,
        abandonClient,
        nativeHookRelayGeneration: "original-relay",
        pluginThreadConfig: {
          enabled: true,
          requiresCurrentPolicyCheck: true,
          inputFingerprint: "warm-app-input",
          build: async () => {
            await pause("plugin config");
            return {
              enabled: true,
              fingerprint: "warm-app-config",
              inputFingerprint: "warm-app-input",
              diagnostics: [],
              configPatch: createPluginAppConfigPatch(),
              policyContext: createPluginAppPolicyContext(),
              provisionalAppIds: ["fixture-app"],
            };
          },
        },
      };
      const started = await startOrResumeThread(common);
      await retainCodexAppServerLiveThread(
        client,
        started.threadId,
        undefined,
        started.liveThreadConfigFingerprint,
        null,
        started.liveThreadEphemeralPolicy,
      );
      fixture.seed(threadStartResult("sibling"), { loaded: true, subscribed: true });
      const sibling = await claimCodexAppServerLiveThread(client, "sibling");
      expect(sibling).toBeDefined();
      const before = await readCodexAppServerBinding(sessionFile);
      request.mockClear();
      warming = true;
      const pending = startOrResumeThread({
        ...common,
        nativeHookRelayGeneration: "stale-refresh",
      });
      await entered.promise;
      expect(isCodexAppServerLiveThreadClaimed(client, started.threadId)).toBe(true);
      expect(request.mock.calls.some(([method]) => method.startsWith("thread/"))).toBe(false);
      let successor: typeof sibling;
      if (revocation === "host") {
        closeHost();
      } else {
        fixture.notify({
          method: revocation as "thread/closed" | "thread/archived",
          params: { threadId: started.threadId },
        });
        successor = await claimCodexAppServerLiveThread(client, started.threadId);
        expect(successor).toBeDefined();
      }
      proceed.resolve();
      const error = await pending.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(AgentHarnessPreflightError);
      expect(error).toMatchObject({
        name: "AgentHarnessPreflightError",
        scope: undefined,
        message: expect.stringContaining("reconnect before continuing"),
      });
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(before);
      expect(() => sibling!.assertCurrent()).not.toThrow();
      if (successor) {
        expect(() => successor.assertCurrent()).not.toThrow();
      }
      expect(
        request.mock.calls
          .filter(([method]) => method.startsWith("thread/"))
          .map(([method, requestParams]) => [method, requestParams]),
      ).toEqual(
        revocation === "host" ? [["thread/unsubscribe", { threadId: started.threadId }]] : [],
      );
      expect(abandonClient).not.toHaveBeenCalled();
      expect(client.getCloseError()).toBeUndefined();
    },
  );

  it("cold-resumes a warm thread to clear stale enforcing PreToolUse hooks", async () => {
    const sessionFile = path.join(tempDir, "warm-cleared-hooks-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-cleared-hooks-workspace");
    const params = createParams(sessionFile, workspaceDir);
    const fake = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond: async (method: string) => {
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/start" || method === "thread/resume") {
          return threadStartResult("thread-warm-cleared-hooks");
        }
        throw new Error(`unexpected method: ${method}`);
      },
    });
    const client = fake.client;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const buildFinalConfigPatch = vi
      .fn()
      .mockReturnValueOnce({
        configPatch: {
          "features.hooks": true,
          "hooks.PreToolUse": [
            {
              hooks: [
                {
                  type: "command",
                  command: "openclaw hooks relay --event pre_tool_use",
                },
              ],
            },
          ],
        },
        nativeHookRelayGeneration: "generation-policy",
      })
      .mockReturnValueOnce({
        configPatch: { "features.hooks": true, "hooks.PreToolUse": [] },
        nativeHookRelayGeneration: "generation-no-policy",
      });
    const common = {
      client,
      params,
      userMcpServersEnabled: false,
      buildFinalConfigPatch,
    };

    const started = await startOrResumeThread(common);
    await expect(retainThread(client, started)).resolves.toBe(true);
    const resumed = await startOrResumeThread(common);

    expect(resumed).toMatchObject({
      threadId: "thread-warm-cleared-hooks",
      nativeHookRelayGeneration: "generation-no-policy",
      lifecycle: { action: "resumed" },
    });
    expect(fake.request.mock.calls.map(([method]) => method)).toEqual(WARM_RESUME_METHODS);
    const resumeConfig = fake.request.mock.calls.find(
      ([method]) => method === "thread/resume",
    )?.[1];
    expect(resumeConfig).toMatchObject({
      config: { "features.hooks": true, "hooks.PreToolUse": [] },
    });
    expect(JSON.stringify(resumeConfig)).not.toContain("openclaw hooks relay");
  });

  it("cold-resumes a warm thread when final config adds an image-generation deny", async () => {
    const sessionFile = path.join(tempDir, "warm-image-deny-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-image-deny-workspace");
    const params = createParams(sessionFile, workspaceDir);
    const respond = createFixedThreadRequest("thread-warm-image-deny", [
      "thread/start",
      "thread/resume",
    ]);
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;
    const common = {
      client,
      params,
      userMcpServersEnabled: false,
    };

    const started = await startOrResumeThread(common);
    await expect(retainThread(client, started)).resolves.toBe(true);
    params.pluginHarnessToolPolicySafeDeniedTools = ["image_generate"];
    const resumed = await startOrResumeThread(common);

    expect(resumed).toMatchObject({
      threadId: "thread-warm-image-deny",
      lifecycle: { action: "resumed" },
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual(WARM_RESUME_METHODS);
    expect(request.mock.calls.find(([method]) => method === "thread/resume")?.[1]).toMatchObject({
      config: { "features.image_generation": false },
    });
  });

  it("keeps a warm native session across sticky environment selection changes", async () => {
    const sessionFile = path.join(tempDir, "environment-session.jsonl");
    const workspaceDir = path.join(tempDir, "environment-workspace");
    const request = createFixedThreadRequest("thread-environments", ["thread/start"]);
    const client = {
      getInstanceId: () => "client-environments",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const common = {
      client,
      params: createParams(sessionFile, workspaceDir),
      userMcpServersEnabled: false,
    };
    const firstSelection = [{ environmentId: "environment-a", cwd: workspaceDir }];
    const secondSelection = [{ environmentId: "environment-b", cwd: workspaceDir }];

    const started = await startOrResumeThread({
      ...common,
      environmentSelection: firstSelection,
    });
    await expect(retainThread(client, started)).resolves.toBe(true);
    const switched = await startOrResumeThread({
      ...common,
      environmentSelection: secondSelection,
    });
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-environments",
      environmentSelectionFingerprint: fingerprintEnvironmentSelection(secondSelection),
    });
    await expect(
      retainCodexAppServerLiveThread(
        client,
        switched.threadId,
        switched.liveThreadOwnership?.release,
        switched.liveThreadConfigFingerprint,
      ),
    ).resolves.toBe(true);
    const restored = await startOrResumeThread({
      ...common,
      environmentSelection: firstSelection,
    });

    expect(switched.threadId).toBe(started.threadId);
    expect(restored.threadId).toBe(started.threadId);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      ...PREFLIGHT_METHODS,
      "thread/start",
      ...PREFLIGHT_METHODS,
      ...PREFLIGHT_METHODS,
    ]);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      environmentSelectionFingerprint: fingerprintEnvironmentSelection(firstSelection),
    });
  });

  it.each([
    {
      label: "cold native thread with no stored tools",
      options: { cold: true, omitCatalog: true, receipt: "none" as const },
    },
  ])(
    "configures the actual manual-resume binding without replacing its native thread: $label",
    async ({ options }) => {
      const fixture = await createManualResumeFixture(options);
      try {
        const resumed = await fixture.start();
        expect(resumed).toMatchObject({
          threadId: fixture.threadId,
          clientId: fixture.client.getInstanceId(),
          lifecycle: { action: "resumed" },
        });
        expect(
          (await readCodexAppServerBinding(fixture.sessionFile))?.pendingResumeConfiguration,
        ).toBeUndefined();
        expect(
          fixture.request.mock.calls
            .map(([method]) => method)
            .filter((method) => method !== "skills/list"),
        ).toEqual([
          "thread/read",
          "thread/resume",
          ...PREFLIGHT_METHODS,
          "thread/read",
          "thread/unsubscribe",
          "thread/resume",
          "thread/inject_items",
        ]);
      } finally {
        fixture.close();
      }
    },
  );

  it.each([
    { options: { receipt: "unrelated" as const }, error: "did not confirm unloading" },
    { options: { receipt: "stale" as const }, error: "did not confirm unloading" },
    { options: { missingMetadata: true }, error: "tool catalog could not be read" },
    {
      options: { recordedTools: [createNamedDynamicTool("old-tool")] },
      error: "immutable native tool catalog",
    },
    { options: { active: true }, error: "native thread is not idle" },
  ])(
    "preserves pending manual resume when native configuration cannot be attested: $options",
    async ({ options, error }) => {
      const fixture = await createManualResumeFixture(options);
      const before = await readCodexAppServerBinding(fixture.sessionFile);
      try {
        await resolveCodexNativeSkillIsolation({
          client: fixture.client,
          cwd: fixture.common.cwd,
          codexHome: fixture.common.appServer.start.env?.CODEX_HOME,
          home: fixture.common.appServer.start.env?.HOME,
          userProfile: fixture.common.appServer.start.env?.USERPROFILE,
        });
        const handlers = [...fixture.notifications];
        await expect(fixture.start()).rejects.toThrow(error);
        expect(await readCodexAppServerBinding(fixture.sessionFile)).toEqual(before);
        expect(fixture.request.mock.calls.some(([method]) => method === "thread/start")).toBe(
          false,
        );
        expect([...fixture.notifications]).toEqual(handlers);
      } finally {
        fixture.close();
      }
    },
  );

  it.each(["claimed", "sibling"] as const)(
    "does not unsubscribe a pending manual-resume thread owned by %s work",
    async (owner) => {
      const fixture = await createManualResumeFixture();
      try {
        if (owner === "claimed") {
          await claimCodexAppServerLiveThread(fixture.client, fixture.threadId);
        } else {
          await testCodexAppServerBindingStore.mutate(
            { kind: "conversation", bindingId: "surviving-conversation" },
            {
              kind: "set",
              binding: {
                threadId: fixture.threadId,
                clientId: fixture.client.getInstanceId(),
                cwd: fixture.common.cwd,
              },
            },
          );
        }
        const before = await readCodexAppServerBinding(fixture.sessionFile);
        await expect(fixture.start()).rejects.toThrow(
          owner === "claimed" ? "claimed by active work" : "owned by another",
        );
        expect(await readCodexAppServerBinding(fixture.sessionFile)).toEqual(before);
        expect(
          fixture.request.mock.calls
            .map(([method]) => method)
            .filter((method) => method !== "skills/list"),
        ).toEqual(
          owner === "claimed"
            ? ["thread/read", "thread/resume", "config/read", "configRequirements/read"]
            : ["thread/read", "thread/resume"],
        );
      } finally {
        fixture.close();
      }
    },
  );

  it.each(["user-home", "unknown-search"] as const)(
    "preserves pending manual resume outside its supported configuration scope: %s",
    async (scope) => {
      const fixture = await createManualResumeFixture();
      try {
        const overrides: Partial<Parameters<typeof startOrResumeThread>[0]> =
          scope === "unknown-search"
            ? { nativeProviderWebSearchSupport: "unknown" }
            : {
                appServer: {
                  ...fixture.common.appServer,
                  start: { ...fixture.common.appServer.start, homeScope: "user" },
                },
              };
        const before = await readCodexAppServerBinding(fixture.sessionFile);
        await expect(fixture.start(overrides)).rejects.toThrow(
          "Cannot configure resumed Codex thread",
        );
        expect(await readCodexAppServerBinding(fixture.sessionFile)).toEqual(before);
        expect(
          fixture.request.mock.calls.some(
            ([method]) => method === "thread/start" || method === "thread/unsubscribe",
          ),
        ).toBe(false);
      } finally {
        fixture.close();
      }
    },
  );

  it.each(["reader", "retired"] as const)(
    "checks physical ownership after a %s interleaves behind the native config fence",
    async (interleaving) => {
      const fixture = await createManualResumeFixture({ wireClient: true });
      const before = await readCodexAppServerBinding(fixture.sessionFile);
      const fenceKey = resolveCodexNativeConfigFenceKey({ client: fixture.client });
      expect(fenceKey).toBeTypeOf("string");
      const releaseFence = await acquireCodexNativeConfigFence(fenceKey!);
      const guardEntered = createDeferred<void>();
      const abort = new AbortController();
      fixture.client.setThreadSessionRequestGuard(async (options) => {
        guardEntered.resolve();
        return await acquireCodexNativeConfigFence(fenceKey!, options);
      });
      const starting = fixture.start({ signal: abort.signal });
      const settled = starting.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await Promise.race([
          guardEntered.promise,
          settled.then(() => {
            throw new Error("manual resume settled before reaching its native config fence");
          }),
        ]);
        const releaseSibling = retainSharedCodexAppServerClientIfCurrent(fixture.client);
        expect(releaseSibling).toBeTypeOf("function");
        releaseSibling?.();
        if (interleaving === "retired") {
          retireSharedCodexAppServerClientIfCurrent(fixture.client);
        }
        releaseFence();

        if (interleaving === "retired") {
          await expect(starting).rejects.toThrow("connection changed");
          expect(await readCodexAppServerBinding(fixture.sessionFile)).toEqual(before);
        } else {
          await expect(starting).resolves.toMatchObject({ threadId: fixture.threadId });
          expect(
            (await readCodexAppServerBinding(fixture.sessionFile))?.pendingResumeConfiguration,
          ).toBeUndefined();
        }
        expect(fixture.client.getCloseError()).toBeUndefined();
        expect(
          fixture
            .wire!.writes.map((message) => (JSON.parse(message) as RpcRequest).method)
            .filter((method) => method === "thread/resume"),
        ).toEqual(
          interleaving === "retired" ? ["thread/resume"] : ["thread/resume", "thread/resume"],
        );
      } finally {
        abort.abort();
        releaseFence();
        await settled;
        fixture.close();
      }
    },
  );

  it.each(["attach", "release", "reset"] as const)(
    "queues same-thread %s behind ordinary preparation without blocking siblings",
    async (operation) => {
      const fixture = await createManualResumeFixture({ wireClient: true });
      await fixture.start();
      fixture.wire!.writes.length = 0;
      const entered = createDeferred<void>();
      const proceed = createDeferred<void>();
      fixture.client.setThreadSessionRequestGuard(async () => {
        entered.resolve();
        await proceed.promise;
        return () => {};
      });
      const starting = fixture.start();
      const settledStart = Promise.allSettled([starting]);
      let mutation: Promise<unknown> | undefined;
      try {
        await Promise.race([
          entered.promise,
          settledStart.then(() => {
            throw new Error("resume failed before its write fence");
          }),
        ]);
        mutation =
          operation === "attach"
            ? fixture.attach()
            : operation === "reset"
              ? retireCodexAppServerSessionGeneration({
                  bindingStore: testCodexAppServerBindingStore,
                  identity: fixture.identity,
                  mode: "reset",
                })
              : withCodexAppServerThreadMutation(fixture.threadId, () =>
                  testCodexAppServerBindingStore.withLease(fixture.identity, async () => {
                    const binding = testCodexAppServerBindingStore.read(fixture.identity);
                    if (binding) {
                      await releaseCodexAppServerBindingSubscription(binding, {
                        allowUntracked: true,
                      });
                    }
                  }),
                );
        let mutationSettled = false;
        const settledMutation = mutation.finally(() => {
          mutationSettled = true;
        });
        const results = Promise.allSettled([starting, settledMutation]);
        await withCodexAppServerThreadMutation("unrelated-thread", async () => {});
        expect(mutationSettled).toBe(false);
        proceed.resolve();
        for (const result of await results) {
          expect(
            result.status,
            result.status === "rejected" ? String(result.reason) : operation,
          ).toBe("fulfilled");
        }
        const methods = fixture.wire!.writes.map((line) => (JSON.parse(line) as RpcRequest).method);
        expect(methods.indexOf("thread/inject_items")).toBeGreaterThan(
          methods.lastIndexOf("thread/read", methods.indexOf("thread/inject_items")),
        );
        expect((await readCodexAppServerBinding(fixture.sessionFile))?.threadId).toBe(
          operation === "reset" ? undefined : fixture.threadId,
        );
      } finally {
        proceed.resolve();
        await Promise.allSettled([starting, mutation]);
        fixture.close();
      }
    },
  );

  it.each([
    { pending: true, change: "delete", nativeModelOwned: false },
    { pending: false, change: "replace-client", nativeModelOwned: false },
    { pending: false, change: "delete", nativeModelOwned: true },
  ])(
    "rejects a changed binding queued for preparation ($change, manual intent: $pending, native model: $nativeModelOwned)",
    async ({ pending, change, nativeModelOwned }) => {
      const fixture = await createManualResumeFixture();
      const nativeModel = threadStartResult(fixture.threadId);
      if (!pending) {
        await testCodexAppServerBindingStore.mutate(fixture.identity, {
          kind: "patch",
          threadId: fixture.threadId,
          patch: {
            pendingResumeConfiguration: undefined,
            preserveNativeModel: nativeModelOwned ? true : undefined,
            ...(nativeModelOwned
              ? { model: nativeModel.model, modelProvider: nativeModel.modelProvider }
              : {}),
          },
        });
      }
      if (nativeModelOwned) {
        fixture.common.params.expectedSessionRuntimeOwnership = {
          model: "native",
          auth: "host",
          modelRef: { model: nativeModel.model, provider: nativeModel.modelProvider },
        };
      }
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const blocker = withCodexAppServerThreadMutation(fixture.threadId, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const readBinding = testCodexAppServerBindingStore.read.bind(testCodexAppServerBindingStore);
      const read = vi.spyOn(testCodexAppServerBindingStore, "read");
      const pendingRead = createDeferred<void>();
      read.mockImplementationOnce((identity) => {
        const binding = readBinding(identity);
        pendingRead.resolve();
        return binding;
      });
      const starting = fixture.start();
      try {
        await pendingRead.promise;
        const current = await readCodexAppServerBinding(fixture.sessionFile);
        expect(current).toBeDefined();
        await testCodexAppServerBindingStore.mutate(
          fixture.identity,
          change === "delete"
            ? { kind: "clear", threadId: fixture.threadId }
            : {
                kind: "set",
                binding: {
                  ...current!,
                  ...(change === "replace-client"
                    ? { clientId: "replacement-client" }
                    : { threadId: "replacement-thread" }),
                },
              },
        );
        release.resolve();
        await expect(starting).rejects.toThrow(
          nativeModelOwned && change === "delete"
            ? "native session ownership is missing or changed"
            : "acquiring thread lifecycle ownership",
        );
        expect(fixture.request.mock.calls.map(([method]) => method)).toEqual([
          "thread/read",
          "thread/resume",
        ]);
      } finally {
        release.resolve();
        await blocker;
        read.mockRestore();
        fixture.close();
      }
    },
  );

  it("releases a retained subscription when its unchanged binding loses ownership", async () => {
    const sessionFile = path.join(tempDir, "warm-conflict-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-conflict-workspace");
    const params = createParams(sessionFile, workspaceDir);
    const request = createLifecycleRequest(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-warm-conflict");
      }
      if (method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const { client } = createFakeCodexAppServerClient(request);
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const common = {
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };
    const started = await startOrResumeThread(common);
    await retainThread(client, started);
    const conflictBindingStore = {
      ...testCodexAppServerBindingStore,
      mutate: vi.fn(async (...args: Parameters<typeof testCodexAppServerBindingStore.mutate>) => {
        if (args[1].kind === "patch") {
          return false;
        }
        return await testCodexAppServerBindingStore.mutate(...args);
      }),
    };

    await expect(
      startOrResumeThreadImpl({ ...common, bindingStore: conflictBindingStore }),
    ).rejects.toMatchObject({ name: "CodexThreadBindingConflictError" });

    expect(conflictBindingStore.mutate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "patch", threadId: "thread-warm-conflict" }),
      expect.any(Function),
      expect.objectContaining({
        assertCurrent: expect.any(Function),
        withCurrent: expect.any(Function),
      }),
    );
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      ...PREFLIGHT_METHODS,
      "thread/start",
      ...PREFLIGHT_METHODS,
      "thread/unsubscribe",
    ]);
  });

  it("releases a retained subscription before changing context-engine mode", async () => {
    const sessionFile = path.join(tempDir, "warm-context-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-context-workspace");
    const params = createParams(sessionFile, workspaceDir);
    let startCount = 0;
    const request = createLifecycleRequest(async (method: string) => {
      if (method === "thread/start") {
        startCount += 1;
        return threadStartResult(`thread-warm-context-${startCount}`);
      }
      if (method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-warm-context",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const common = {
      client,
      params,
      userMcpServersEnabled: false,
    };
    const started = await startOrResumeThread(common);
    await expect(retainThread(client, started)).resolves.toBe(true);

    params.contextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn(),
      compact: vi.fn(),
    } as never;
    params.contextTokenBudget = 400_000;
    const rotated = await startOrResumeThread(common);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      ...PREFLIGHT_METHODS,
      "thread/start",
      ...PREFLIGHT_METHODS,
      "thread/unsubscribe",
      "thread/start",
    ]);
    expect(rotated).toMatchObject({
      threadId: "thread-warm-context-2",
      contextEngine: { engineId: "lossless-claw" },
      lifecycle: { action: "started", rotatedContextEngineBinding: true },
    });
  });

  it("resumes a retained persistent thread with refreshed persona and skills", async () => {
    const sessionFile = path.join(tempDir, "warm-skills-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-skills-workspace");
    const params = createParams(sessionFile, workspaceDir);
    const respond = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-warm-skills");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;
    const common = {
      client,
      params,
      userMcpServersEnabled: false,
      developerInstructions: "generic policy",
    };
    const firstSkills =
      "## OpenClaw Skills\n\nweather\n\n<AGENT_SOUL>Original persona</AGENT_SOUL>";
    const secondSkills = "## OpenClaw Skills\n\nweather\n\n<AGENT_SOUL>Edited persona</AGENT_SOUL>";
    const started = await startOrResumeThread({ ...common, refreshableInstructions: firstSkills });
    // The catalog rides the thread developer carrier, after the generic policy.
    expect(request.mock.calls.find(([method]) => method === "thread/start")?.[1]).toMatchObject({
      developerInstructions: `generic policy\n\n${firstSkills}`,
    });
    await retainThread(client, started);

    // Editing a skill must reach a live persistent conversation. The catalog is part
    // of the thread carrier, so warm reuse is invalidated and the same thread is
    // cold-resumed with the new catalog instead of losing the conversation.
    const resumed = await startOrResumeThread({ ...common, refreshableInstructions: secondSkills });

    expect(resumed).toMatchObject({
      threadId: "thread-warm-skills",
      lifecycle: { action: "resumed" },
    });
    expect(resumed.liveThreadConfigFingerprint).not.toBe(started.liveThreadConfigFingerprint);
    expect(request.mock.calls.map(([method]) => method)).toEqual(WARM_RESUME_METHODS);
    const resumeParams = request.mock.calls.find(([method]) => method === "thread/resume")?.[1];
    expect(resumeParams).toMatchObject({
      developerInstructions: `generic policy\n\n${secondSkills}`,
    });
    // The refreshed catalog also reaches the live conversation through the existing
    // generic policy handoff, so the resumed turn is not answered from the old catalog.
    const injected = request.mock.calls.find(([method]) => method === "thread/inject_items")?.[1];
    expect(injected).toMatchObject({
      threadId: "thread-warm-skills",
      items: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: expect.stringContaining(secondSkills) }],
        },
      ],
    });
  });

  it("releases and resumes a retained thread when its auth profile changes", async () => {
    const sessionFile = path.join(tempDir, "warm-auth-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-auth-workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.authProfileId = "openai:before";
    const respond = createFixedThreadRequest("thread-warm-auth", ["thread/start", "thread/resume"]);
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;
    const common = {
      client,
      params,
      userMcpServersEnabled: false,
    };
    const started = await startOrResumeThread(common);
    await retainThread(client, started);

    params.authProfileId = "openai:after";
    const resumed = await startOrResumeThread(common);

    expect(request.mock.calls.map(([method]) => method)).toEqual(WARM_RESUME_METHODS);
    expect(resumed).toMatchObject({
      authProfileId: "openai:after",
      threadId: "thread-warm-auth",
      lifecycle: { action: "resumed" },
    });
    expect(resumed.liveThreadConfigFingerprint).not.toBe(started.liveThreadConfigFingerprint);
  });

  it("rejects MCP drift when restarting a required-workspace incognito thread", async () => {
    const sessionFile = path.join(tempDir, "incognito-session.jsonl");
    const workspaceDir = path.join(tempDir, "incognito-workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.sessionKey = "agent:main:dashboard:incognito-two-turns";
    params.requireWorkspaceOnly = true;
    params.sessionRoot = workspaceDir;
    let secondTurn = false;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "config/read") {
        return { layers: [], config: { mcp_servers: {} } };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "mcpServerStatus/list") {
        return {
          data: secondTurn
            ? [
                {
                  ...disabledMcpServerStatus("unexpected-server"),
                  serverInfo: { name: "unexpected-server", version: "1.0" },
                  tools: { unexpected_tool: { name: "unexpected_tool", inputSchema: {} } },
                },
              ]
            : [],
          nextCursor: null,
        };
      }
      if (method === "thread/start") {
        return threadStartResult("thread-incognito");
      }
      if (method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-incognito",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const common = {
      client,
      params,
      userMcpServersEnabled: false,
      nativeCodeModeEnabled: false,
    };

    const first = await startOrResumeThread(common);
    expect(request.mock.calls.find(([method]) => method === "thread/start")?.[1]).toEqual(
      expect.objectContaining({ environments: [] }),
    );
    await retainCodexAppServerLiveThread(
      client,
      first.threadId,
      undefined,
      first.liveThreadConfigFingerprint,
      null,
      first.liveThreadEphemeralPolicy,
    );
    const before = await readCodexAppServerBinding(sessionFile);
    secondTurn = true;
    await expect(startOrResumeThread(common)).rejects.toThrow(
      "Codex restricted-tool-surface MCP attestation found unexpected server unexpected-server",
    );
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(before);
    expect(
      request.mock.calls
        .filter(([method]) => method.startsWith("thread/"))
        .map(([method, requestParams]) => [method, requestParams]),
    ).toEqual([
      ["thread/start", expect.objectContaining({ ephemeral: true })],
      ["thread/start", expect.objectContaining({ ephemeral: true, environments: [] })],
      ["thread/unsubscribe", { threadId: first.threadId }],
    ]);
  });

  it.each([
    { change: "policy", policy: "generic policy v2", skills: "## OpenClaw Skills\n\nweather" },
    { change: "skills", policy: "generic policy", skills: undefined },
  ] as const)(
    "refreshes live incognito instructions but refuses generic policy drift ($change: $skills)",
    async ({ change, policy, skills }) => {
      const sessionFile = path.join(tempDir, "incognito-session.jsonl");
      const workspaceDir = path.join(tempDir, "incognito-workspace");
      const params = createParams(sessionFile, workspaceDir);
      params.sessionKey = "agent:main:dashboard:incognito-skill-refresh";
      const request = vi.fn(async (method: string, _params?: unknown) => {
        if (method === "config/read") {
          return { layers: [], config: { mcp_servers: {} } };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/start") {
          return threadStartResult("thread-incognito");
        }
        if (method === "thread/inject_items") {
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const client = {
        getInstanceId: () => "client-incognito",
        request,
        addNotificationHandler: () => () => undefined,
        addRequestHandler: () => () => undefined,
        addCloseHandler: () => () => undefined,
      } as never;
      ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
      const common = {
        client,
        params,
        userMcpServersEnabled: false,
      };
      const firstSkills =
        "## OpenClaw Skills\n\nweather\n\n<AGENT_SOUL>Original persona</AGENT_SOUL>";
      const first = await startOrResumeThread({
        ...common,
        developerInstructions: "generic policy",
        refreshableInstructions: firstSkills,
      });
      expect(first.liveThreadEphemeralPolicy).toEqual({
        developerInstructions: "generic policy",
        refreshableInstructions: firstSkills,
        // Creation carries the catalog natively, so compaction restores this one.
        nativeRefreshableInstructions: firstSkills,
      });
      expect(request.mock.calls.find(([method]) => method === "thread/start")?.[1]).toEqual(
        expect.objectContaining({
          ephemeral: true,
          developerInstructions: `generic policy\n\n${firstSkills}`,
        }),
      );
      await retainCodexAppServerLiveThread(
        client,
        first.threadId,
        undefined,
        first.liveThreadConfigFingerprint,
        null,
        first.liveThreadEphemeralPolicy,
      );
      const threadCalls = () =>
        request.mock.calls
          .filter(([method]) => method.startsWith("thread/"))
          .map(([method, requestParams]) => [method, requestParams]);
      const secondTurn = {
        ...common,
        developerInstructions: policy,
        refreshableInstructions: skills,
      };

      if (change === "policy") {
        await expect(startOrResumeThread(secondTurn)).rejects.toBeInstanceOf(
          CodexIncognitoPolicyChangeError,
        );
        expect(threadCalls().map(([method]) => method)).toEqual(["thread/start"]);
        // The refusal keeps the ephemeral conversation retained for a corrected turn.
        expect(hasCodexAppServerLiveThread(client, first.threadId)).toBe(true);
        return;
      }

      const second = await startOrResumeThread(secondTurn);
      expect(second).toMatchObject({
        threadId: first.threadId,
        lifecycle: { action: "resumed" },
        liveThreadEphemeralPolicy: {
          developerInstructions: "generic policy",
          refreshableInstructions: skills,
          // A refresh never rewrites native instructions, so the creation-time
          // catalog stays recorded as the one compaction will restore.
          nativeRefreshableInstructions: firstSkills,
        },
      });
      expect(threadCalls()).toEqual([
        ["thread/start", expect.objectContaining({ ephemeral: true })],
        [
          "thread/inject_items",
          {
            threadId: first.threadId,
            items: [
              {
                type: "message",
                role: "developer",
                content: [
                  {
                    type: "input_text",
                    text: expect.stringContaining(
                      skills ?? "The current OpenClaw refreshable thread instructions are empty",
                    ),
                  },
                ],
              },
            ],
          },
        ],
      ]);
      // The delivered catalog travels with the binding so cleanup retains it and
      // an unchanged catalog on the next turn is not re-delivered.
      await retainCodexAppServerLiveThread(
        client,
        second.threadId,
        second.liveThreadOwnership?.release,
        second.liveThreadConfigFingerprint,
        null,
        second.liveThreadEphemeralPolicy,
      );
      const third = await startOrResumeThread(secondTurn);
      expect(third.lifecycle).toEqual({ action: "resumed" });
      expect(threadCalls().map(([method]) => method)).toEqual([
        "thread/start",
        "thread/inject_items",
      ]);
    },
  );

  it("isolates transient message-only completion threads without replacing the parent binding", async () => {
    const sessionFile = path.join(tempDir, "message-only-session.jsonl");
    const workspaceDir = path.join(tempDir, "message-only-workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-parent",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.toolsAllow = ["message"];
    params.sourceReplyDeliveryMode = "message_tool_only";
    params.delegationCapability = "report_only";
    params.inputProvenance = {
      kind: "inter_session",
      sourceSessionKey: "agent:main:subagent:child",
      sourceChannel: "internal",
      sourceTool: "subagent_announce",
    };
    let nextThread = 1;
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "config/read") {
        return {
          layers: [{ name: { type: "packagedDefaults", file: "/managed/codex/defaults.toml" } }],
          config: {
            mcp_servers: {
              "arbitrary.server": { command: "inherited-mcp" },
              "local helper": { url: "https://mcp.example.test" },
            },
          },
        };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start") {
        return threadStartResult(`thread-message-only-${nextThread++}`);
      }
      if (method === "mcpServerStatus/list") {
        return {
          data: [
            disabledMcpServerStatus("arbitrary.server"),
            disabledMcpServerStatus("local helper"),
            disabledMcpServerStatus("request-only"),
          ],
          nextCursor: null,
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const messageTool = createMessageDynamicTool("Send the source conversation reply");
    const common = {
      client: { request } as never,
      params,
      appServer: createThreadLifecycleAppServerOptions(),
      dynamicTools: [messageTool],
      config: {
        "features.apps": true,
        "features.chronicle": true,
        "features.current_time_reminder": true,
        "features.deferred_executor": true,
        "features.hooks": true,
        "features.image_generation": true,
        "features.multi_agent": true,
        "features.multi_agent_v2": true,
        "features.plugins": true,
        "features.skill_search": true,
        "features.shell_tool": true,
        "features.standalone_web_search": true,
        "features.token_budget": true,
        "features.unified_exec": true,
        "features.view_image": true,
        "orchestrator.mcp.enabled": true,
        "tools.experimental_request_user_input.enabled": true,
        "tools.update_plan.enabled": true,
        mcp_servers: {
          "request-only": { command: "request-mcp" },
        },
        web_search: "live",
      },
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
      hostSystemAgentActive: false,
    };

    const first = await startOrResumeThread(common);
    const second = await startOrResumeThread(common);

    expect(first.lifecycle.action).toBe("started");
    expect(second.lifecycle.action).toBe("started");
    expect(first.threadId).toBe("thread-message-only-1");
    expect(second.threadId).toBe("thread-message-only-2");
    expect(first).not.toHaveProperty("liveThreadConfigFingerprint");
    expect(second).not.toHaveProperty("liveThreadConfigFingerprint");
    expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe("thread-parent");
    const threadRequests = request.mock.calls.filter(([method]) => method === "thread/start");
    expect(threadRequests).toHaveLength(2);
    const resumeRequest = buildThreadResumeParams(params, {
      threadId: first.threadId,
      appServer: common.appServer,
      dynamicTools: common.dynamicTools,
      config: common.config,
      nativeCodeModeEnabled: false,
      hostSystemAgentActive: false,
      restrictedToolSurfaceInheritedMcpServerNames: ["arbitrary.server", "local helper"],
    });
    const threadPayloads = [
      ...threadRequests.map(([, threadRequest]) => threadRequest),
      resumeRequest,
    ];
    for (const threadRequest of threadPayloads) {
      expect(threadRequest).toEqual(
        expect.objectContaining({
          config: expect.objectContaining({
            mcp_servers: {
              "arbitrary.server": { enabled: false },
              "local helper": { enabled: false },
              "request-only": { command: "request-mcp", enabled: false },
            },
            web_search: "disabled",
          }),
          developerInstructions: expect.not.stringContaining("`message(action=send)`"),
        }),
      );
      const typedThreadRequest = threadRequest as {
        config?: Record<string, unknown>;
        developerInstructions?: string;
      };
      const threadConfig = typedThreadRequest.config;
      for (const disabledFeature of [
        "features.apps",
        "features.current_time_reminder",
        "features.deferred_executor",
        "features.hooks",
        "features.image_generation",
        "features.multi_agent",
        "features.multi_agent_v2",
        "features.plugins",
        "features.standalone_web_search",
        "features.token_budget",
        "orchestrator.mcp.enabled",
        "tools.experimental_request_user_input.enabled",
        "tools.update_plan.enabled",
      ]) {
        expect(threadConfig?.[disabledFeature]).toBe(false);
      }
      expect(typedThreadRequest.developerInstructions).not.toContain("`spawn_agent`");
      expect(typedThreadRequest.developerInstructions).not.toContain("`tool_search`");
    }
    for (const [, startRequest] of threadRequests) {
      expect(startRequest).toEqual(
        expect.objectContaining({ dynamicTools: [messageTool], environments: [] }),
      );
    }
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      ...PREFLIGHT_METHODS,
      "thread/start",
      "mcpServerStatus/list",
      ...PREFLIGHT_METHODS,
      "thread/start",
      "mcpServerStatus/list",
    ]);
    for (const threadId of ["thread-message-only-1", "thread-message-only-2"]) {
      expect(request).toHaveBeenCalledWith(
        "mcpServerStatus/list",
        { threadId, detail: "toolsAndAuthOnly" },
        expect.anything(),
      );
    }
  });

  it.each([
    { cleanup: "unconfirmed", cleanupFails: true, revokeHost: false },
    { cleanup: "host revoked", cleanupFails: false, revokeHost: true },
  ])(
    "cleans the resumed subscription after MCP attestation failure, cleanup=$cleanup",
    async ({ cleanupFails, revokeHost }) => {
      const { sessionFile, workspaceDir } = createPaths();
      const params = createParams(sessionFile, workspaceDir);
      params.toolsAllow = ["openclaw"];
      const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
      const cleanupEntered = createDeferred<void>();
      const cleanupProceed = createDeferred<void>();
      let attestationCount = 0;
      let rejectUnsubscribe = false;
      let pauseCleanup = false;
      const respond = vi.fn(async (method: string) => {
        if (method === "config/read") {
          return { config: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/start" || method === "thread/resume") {
          return threadStartResult("thread-ring-zero");
        }
        if (method === "mcpServerStatus/list") {
          attestationCount += 1;
          return attestationCount === 1
            ? { data: [], nextCursor: null }
            : { data: [{ name: "late-server" }], nextCursor: null };
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond,
        unsubscribe: async () => {
          if (pauseCleanup) {
            cleanupEntered.resolve();
            await cleanupProceed.promise;
          }
          if (rejectUnsubscribe) {
            throw new Error("unsubscribe unavailable");
          }
          return { status: "unsubscribed" };
        },
      });
      const { client, request } = fixture;
      const abandonClient = vi.fn(async () => {});
      const common = {
        client,
        abandonClient,
        params,
        dynamicTools: [createNamedDynamicTool("openclaw")],
        nativeCodeModeEnabled: false,
        userMcpServersEnabled: false,
        hostSystemAgentActive: true,
      };

      await startOrResumeThread(common);
      await fixture.endTurn("thread-ring-zero");
      const before = await readCodexAppServerBinding(sessionFile);
      rejectUnsubscribe = cleanupFails;
      pauseCleanup = revokeHost;
      const pending = startOrResumeThread(common).catch((cause: unknown) => cause);
      if (revokeHost) {
        await cleanupEntered.promise;
        closeHost();
        cleanupProceed.resolve();
      }
      const error = await pending;
      expect(await readCodexAppServerBinding(sessionFile)).toEqual(before);
      expect(error).toMatchObject({
        name: "CodexThreadPolicyHandoffError",
        outcome: "not-written",
        cause: expect.objectContaining({
          message: "Codex mcpServerStatus/list returned an invalid restricted-tool-surface server",
        }),
      });

      expect(abandonClient).toHaveBeenCalledTimes(cleanupFails || revokeHost ? 1 : 0);
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        ...PREFLIGHT_METHODS,
        "thread/start",
        "mcpServerStatus/list",
        "thread/unsubscribe",
        ...PREFLIGHT_METHODS,
        "thread/read",
        "thread/resume",
        "mcpServerStatus/list",
        "thread/unsubscribe",
      ]);
      expect(
        request.mock.calls.some(
          ([method]) => method === "turn/start" || method === "thread/delete",
        ),
      ).toBe(false);
    },
  );

  it.each([
    {
      expectedError:
        'Codex restricted tool surface cannot override config layer legacyManagedConfigTomlFromFile; migrate /etc/codex/managed_config.toml to /etc/codex/requirements.toml before running restricted or isolated turns. For ChatGPT-only authentication, use allowed_login_methods = ["chatgpt"] in /etc/codex/requirements.toml.',
      name: "legacy managed file",
      layer: {
        name: {
          file: "/etc/codex/managed_config.toml",
          type: "legacyManagedConfigTomlFromFile",
        },
      },
    },
    {
      expectedError:
        'Codex restricted tool surface cannot override config layer legacyManagedConfigTomlFromMdm; replace the legacy MDM payload with base64-encoded TOML requirements in the com.openai.codex managed preference requirements_toml_base64 before running restricted or isolated turns. For ChatGPT-only authentication, include allowed_login_methods = ["chatgpt"] in that TOML payload.',
      name: "legacy managed MDM",
      layer: { name: { type: "legacyManagedConfigTomlFromMdm" } },
    },
    {
      expectedError: /config layer/u,
      name: "unknown future",
      layer: { name: { type: "futureManaged" } },
    },
    { expectedError: /config layers/u, name: "malformed", layer: { name: {} } },
  ])(
    "fails closed on $name config layers before OpenClaw thread/start",
    async ({ expectedError, layer }) => {
      const { sessionFile, workspaceDir } = createPaths();
      const params = createParams(sessionFile, workspaceDir);
      params.toolsAllow = ["openclaw"];
      const request = vi.fn(async (method: string) => {
        if (method === "config/read") {
          return { config: {}, layers: [layer] };
        }
        throw new Error(`unexpected method: ${method}`);
      });

      await expect(
        startOrResumeThread({
          client: { request } as never,
          params,
          dynamicTools: [createNamedDynamicTool("openclaw")],
          nativeCodeModeEnabled: false,
          userMcpServersEnabled: false,
          hostSystemAgentActive: true,
        }),
      ).rejects.toThrow(expectedError);
      expect(request.mock.calls.map(([method]) => method)).toEqual(["config/read"]);
    },
  );

  it.each(["managed_hooks"] as const)(
    "fails closed on non-empty %s requirements before OpenClaw thread/start",
    async (requirementsKey) => {
      const { sessionFile, workspaceDir } = createPaths();
      const params = createParams(sessionFile, workspaceDir);
      params.toolsAllow = ["openclaw"];
      const request = vi.fn(async (method: string) => {
        if (method === "config/read") {
          return { config: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return {
            requirements: {
              [requirementsKey]: {
                PreToolUse: [{ matcher: "*", hooks: [{ type: "command" }] }],
              },
            },
          };
        }
        throw new Error(`unexpected method: ${method}`);
      });

      await expect(
        startOrResumeThread({
          client: { request } as never,
          params,
          dynamicTools: [createNamedDynamicTool("openclaw")],
          nativeCodeModeEnabled: false,
          userMcpServersEnabled: false,
          hostSystemAgentActive: true,
        }),
      ).rejects.toThrow("cannot override managed hooks");
      expect(request.mock.calls.map(([method]) => method)).toEqual([...PREFLIGHT_METHODS]);
    },
  );

  it("admits configured managed hooks for an interactive plugin-policy turn", async () => {
    const sessionFile = path.join(tempDir, "plugin-policy-session.jsonl");
    const workspaceDir = path.join(tempDir, "plugin-policy-workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.pluginHarnessToolPolicyRestricted = true;
    const respond = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return {
          requirements: {
            hooks: {
              PreToolUse: [{ matcher: "*", hooks: [{ type: "command" }] }],
            },
            featureRequirements: { hooks: true },
          },
        };
      }
      if (method === "thread/start") {
        return threadStartResult("thread-plugin-policy-managed-hooks");
      }
      if (method === "mcpServerStatus/list") {
        return { data: [], nextCursor: null };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });

    await expect(
      startOrResumeThread({
        client: fixture.client,
        params,
        nativeCodeModeEnabled: false,
        userMcpServersEnabled: false,
        hostSystemAgentActive: false,
      }),
    ).resolves.toMatchObject({
      threadId: "thread-plugin-policy-managed-hooks",
      lifecycle: { action: "started" },
    });
    expect(fixture.request.mock.calls.map(([method]) => method)).toEqual([
      ...PREFLIGHT_METHODS,
      "thread/start",
      "mcpServerStatus/list",
    ]);
  });

  it("fails closed when requirements pin denied image generation on", async () => {
    const { sessionFile, workspaceDir } = createPaths();
    const params = createParams(sessionFile, workspaceDir);
    params.pluginHarnessToolPolicySafeDeniedTools = ["image_generate"];
    const request = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: { featureRequirements: { image_generation: true } } };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        params,
        userMcpServersEnabled: false,
      }),
    ).rejects.toThrow("cannot override required feature image_generation");
    expect(request.mock.calls.map(([method]) => method)).toEqual([...PREFLIGHT_METHODS]);
  });

  it.each([
    {
      name: "a malformed inventory",
      ephemeral: true,
      attestation: { data: "invalid" },
      failure: "returned an invalid restricted-tool-surface attestation",
    },
  ])(
    "discards the fresh thread after MCP attestation finds $name, ephemeral=$ephemeral",
    async ({ attestation, failure, ephemeral }) => {
      const { sessionFile, workspaceDir } = createPaths();
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-normal",
        cwd: workspaceDir,
        model: "gpt-5.4-codex",
        modelProvider: "openai",
        dynamicToolsFingerprint: "[]",
      });
      const predecessor = await readCodexAppServerBinding(sessionFile);
      const params = createParams(sessionFile, workspaceDir);
      params.toolsAllow = ["openclaw"];
      if (ephemeral) {
        params.sessionKey = "agent:main:internal-session-effects:incognito-mcp-attestation";
      }
      const abandonClient = vi.fn(async () => {});
      const request = vi.fn(async (method: string) => {
        if (method === "config/read") {
          return { config: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/start") {
          return threadStartResult("thread-ring-zero");
        }
        if (method === "thread/delete") {
          return {};
        }
        if (method === "thread/unsubscribe") {
          return { status: "unsubscribed" };
        }
        if (method === "mcpServerStatus/list") {
          if (attestation instanceof Error) {
            throw attestation;
          }
          return attestation;
        }
        throw new Error(`unexpected method: ${method}`);
      });

      await expect(
        startOrResumeThread({
          client: { request } as never,
          abandonClient,
          params,
          dynamicTools: [createNamedDynamicTool("openclaw")],
          nativeCodeModeEnabled: false,
          userMcpServersEnabled: false,
          hostSystemAgentActive: true,
        }),
      ).rejects.toThrow(failure);
      expect(abandonClient).not.toHaveBeenCalled();
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        ...PREFLIGHT_METHODS,
        "thread/start",
        "mcpServerStatus/list",
        ephemeral ? "thread/unsubscribe" : "thread/delete",
      ]);
      expect(await readCodexAppServerBinding(sessionFile)).toEqual(predecessor);
    },
  );

  it.each(["thread-start", "binding-commit"])(
    "discards a fresh thread when abort arrives during %s",
    async (phase) => {
      const { sessionFile } = createPaths();

      const abortController = new AbortController();
      if (phase === "binding-commit") {
        const mutate = testCodexAppServerBindingStore.mutate.bind(testCodexAppServerBindingStore);
        vi.spyOn(testCodexAppServerBindingStore, "mutate").mockImplementation(async (...args) => {
          if (args[1].kind === "set") {
            abortController.abort("test_abort");
          }
          return await mutate(...args);
        });
      }
      const startResponse = createDeferred<ReturnType<typeof threadStartResult>>();
      const request = createLifecycleRequest(async (method: string, _requestParams?: unknown) => {
        if (method === "thread/start") {
          return await startResponse.promise;
        }
        if (method === "thread/delete") {
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      });

      const run = startOrResumeThread({
        client: { request } as never,
        signal: abortController.signal,
      });
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("thread/start", expect.any(Object), {
          signal: abortController.signal,
          assertCurrent: expect.any(Function),
          withCurrent: expect.any(Function),
        }),
      );
      if (phase === "thread-start") {
        abortController.abort("test_abort");
      }
      startResponse.resolve(threadStartResult("thread-after-abort"));

      await expect(run).rejects.toThrow("test_abort");
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        ...PREFLIGHT_METHODS,
        "thread/start",
        "thread/delete",
      ]);
    },
  );

  it.each([["gpt-5.6-luna", "gpt-5.6-sol"]])(
    "starts a fresh thread when switching from %s to %s",
    async (bindingModel, requestedModel) => {
      const sessionFile = path.join(tempDir, `${bindingModel}-${requestedModel}.jsonl`);
      const workspaceDir = path.join(tempDir, "workspace");
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-existing",
        cwd: workspaceDir,
        model: bindingModel,
      });
      const params = createParams(sessionFile, workspaceDir);
      params.modelId = requestedModel;
      const request = createLifecycleRequest(async (method: string, requestParams?: unknown) => {
        if (method === "thread/start") {
          const response = threadStartResult("thread-rebound");
          response.model = (requestParams as { model: string }).model;
          return response;
        }
        throw new Error(`unexpected method: ${method}`);
      });

      const binding = await startOrResumeThread({
        client: { request } as never,
        params,
      });

      expect(request.mock.calls.map(([method]) => method)).toEqual([
        ...PREFLIGHT_METHODS,
        "thread/start",
      ]);
      expect(request.mock.calls.find(([method]) => method === "thread/start")?.[1]).toMatchObject({
        model: requestedModel,
      });
      expect(binding).toMatchObject({
        threadId: "thread-rebound",
        model: requestedModel,
        lifecycle: { action: "started" },
      });
    },
  );

  it.each(["native-model", "aborted", "closed-host", "parent-owned"] as const)(
    "preserves the binding when cold preparation is %s",
    async (condition) => {
      const sessionFile = path.join(tempDir, "preserved-cold.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const agentDir = path.join(tempDir, "agent");
      const params = { ...createParams(sessionFile, workspaceDir), agentDir };
      const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
      const controller = new AbortController();
      const wire = await createLeasedLifecycleWireClient(agentDir, ({ method }) => {
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method !== "thread/read") {
          throw new Error(`Unexpected cold preparation request: ${method}`);
        }
        if (condition === "aborted") {
          controller.abort(new Error("preparation canceled"));
        } else if (condition === "closed-host") {
          closeHost();
        } else if (condition === "parent-owned") {
          return {
            thread: {
              ...threadStartResult("thread-preserved").thread,
              status: { type: "notLoaded" },
              canAcceptDirectInput: false,
            },
          };
        }
        throw new CodexAppServerRpcError(
          {
            code: -32_600,
            message: "thread not loaded: thread-preserved",
          },
          method,
        );
      });
      try {
        await writeCodexAppServerBinding(sessionFile, {
          threadId: "thread-preserved",
          clientId: wire.client.getInstanceId(),
          cwd: workspaceDir,
          modelProvider: "openai",
          ...(condition === "native-model" ? { preserveNativeModel: true } : {}),
        });
        const before = await readCodexAppServerBinding(sessionFile);
        await expect(
          startOrResumeThread({
            client: wire.client,
            params,
            userMcpServersEnabled: false,
            signal: controller.signal,
          }),
        ).rejects.toThrow();
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(before);
        expect(
          new Set(wire.writes.map((message) => (JSON.parse(message) as RpcRequest).method)),
        ).toEqual(new Set(["config/read", "configRequirements/read", "thread/read"]));
      } finally {
        closeHost();
        releaseLeasedSharedCodexAppServerClient(wire.client);
        await wire.client.closeAndWait();
      }
    },
  );

  it("retires an ownership-lost resume client while preserving its binding and draining siblings", async () => {
    const sessionFile = path.join(tempDir, "ownership-lost-session.jsonl");
    const workspaceDir = path.join(tempDir, "ownership-lost-workspace");
    const agentDir = path.join(tempDir, "agent");
    const threadId = "thread-ownership-lost";
    const rolloutPath = path.join(agentDir, "codex-home", "sessions", `rollout-${threadId}.jsonl`);
    await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
    await fs.writeFile(
      rolloutPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: threadId, dynamic_tools: [] } })}\n`,
    );
    const response = threadStartResult(threadId, { cwd: workspaceDir });
    let releaseSibling: (() => void) | undefined;
    const wire = await createLeasedLifecycleWireClient(agentDir, (request) => {
      if (request.method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (request.method === "configRequirements/read") {
        return { requirements: null };
      }
      if (request.method === "thread/read") {
        return { thread: { ...response.thread, path: rolloutPath, status: { type: "notLoaded" } } };
      }
      if (request.method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      if (request.method === "thread/resume") {
        // Retirement revokes this preparation, while an unrelated live lease drains.
        releaseSibling = retainSharedCodexAppServerClientIfCurrent(wire.client);
        retireSharedCodexAppServerClientIfCurrent(wire.client);
        return response;
      }
      throw new Error(`unexpected method: ${request.method}`);
    });
    try {
      await writeCodexAppServerBinding(sessionFile, {
        threadId,
        clientId: wire.client.getInstanceId(),
        cwd: workspaceDir,
        model: response.model,
        modelProvider: "openai",
        dynamicToolsFingerprint: "[]",
        pendingResumeConfiguration: true,
      });
      const originalBinding = await readCodexAppServerBinding(sessionFile);
      await expect(wire.start(sessionFile, workspaceDir)).rejects.toMatchObject({
        name: "CodexThreadPolicyHandoffError",
        outcome: "not-written",
      });

      await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(originalBinding);
      expect(wire.writes.map((message) => (JSON.parse(message) as RpcRequest).method)).toEqual([
        ...PREFLIGHT_METHODS,
        "thread/read",
        "thread/unsubscribe",
        "thread/resume",
      ]);
      expect(releaseSibling).toBeTypeOf("function");
      const retained = retainSharedCodexAppServerClientIfCurrent(wire.client);
      retained?.();
      expect(retained).toBeUndefined();
      expect(releaseLeasedSharedCodexAppServerClient(wire.client)).toBe(true);
      expect(wire.stdinDestroyed).toBe(false);
      await expect(
        wire.client.request("thread/read", { threadId, includeTurns: false }),
      ).resolves.toMatchObject({
        thread: { id: threadId },
      });
      releaseSibling?.();
      expect(wire.stdinDestroyed).toBe(true);
    } finally {
      releaseSibling?.();
      releaseLeasedSharedCodexAppServerClient(wire.client);
      wire.client.close();
    }
  });

  it("preserves the bound thread and shared client after an exact overload rejection", async () => {
    const sessionFile = path.join(tempDir, "overloaded-session.jsonl");
    const workspaceDir = path.join(tempDir, "overloaded-workspace");
    const agentDir = path.join(tempDir, "agent");
    const overload = new CodexAppServerRpcError(
      { code: -32_001, message: "queue full" },
      "thread/resume",
    );
    const wire = await createLeasedLifecycleWireClient(agentDir, (request) => {
      if (request.method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (request.method === "configRequirements/read") {
        return { requirements: null };
      }
      if (request.method === "thread/read") {
        return {
          thread: {
            ...threadStartResult("thread-overloaded").thread,
            status: { type: "notLoaded" },
          },
        };
      }
      if (request.method === "thread/resume") {
        throw overload;
      }
      throw new Error(`unexpected method: ${request.method}`);
    });
    try {
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-overloaded",
        clientId: wire.client.getInstanceId(),
        cwd: workspaceDir,
        model: "gpt-5.4-codex",
        modelProvider: "openai",
        dynamicToolsFingerprint: "[]",
      });
      const originalBinding = await readCodexAppServerBinding(sessionFile);
      await expect(wire.start(sessionFile, workspaceDir)).rejects.toMatchObject({
        name: "CodexAppServerRpcError",
        code: -32_001,
        message: overload.message,
      });

      await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(originalBinding);
      expect(
        new Set(wire.writes.map((message) => (JSON.parse(message) as RpcRequest).method)),
      ).toEqual(
        new Set(["config/read", "configRequirements/read", "thread/read", "thread/resume"]),
      );
      const retained = retainSharedCodexAppServerClientIfCurrent(wire.client);
      expect(retained).toBeTypeOf("function");
      retained?.();
      expect(wire.stdinDestroyed).toBe(false);
    } finally {
      releaseLeasedSharedCodexAppServerClient(wire.client);
      wire.client.close();
    }
  });

  it("keeps the bound local provider when stale fingerprints force a fresh thread", async () => {
    const { sessionFile, workspaceDir } = createPaths();
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "local-model",
      modelProvider: "lmstudio",
      dynamicToolsFingerprint: "stale-fingerprint",
      dynamicToolsContainDeferred: false,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.provider = "codex";
    params.modelId = "local-model-2";

    const request = createLifecycleRequest(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/start") {
        const response = threadStartResult("thread-new");
        response.model = "local-model-2";
        response.modelProvider = "lmstudio";
        response.thread.modelProvider = "lmstudio";
        return response;
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      dynamicTools: [createNamedDynamicTool("web_search")],
    });

    const startParams = request.mock.calls.find(([method]) => method === "thread/start")?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      ...PREFLIGHT_METHODS,
      "thread/start",
    ]);
    expect(startParams?.model).toBe("local-model-2");
    expect(startParams?.modelProvider).toBe("lmstudio");
    expect(binding.threadId).toBe("thread-new");
    expect(binding.modelProvider).toBe("lmstudio");
  });

  it("keeps the bound local provider when the bound model id contains a slash", async () => {
    const { sessionFile, workspaceDir } = createPaths();
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "openai/gpt-oss-20b",
      modelProvider: "lmstudio",
      dynamicToolsFingerprint: "[]",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.provider = "codex";
    params.modelId = "openai/gpt-oss-20b";

    const respond = createLifecycleRequest(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/resume") {
        const response = threadStartResult("thread-existing");
        response.model = "openai/gpt-oss-20b";
        response.modelProvider = "lmstudio";
        response.thread.modelProvider = "lmstudio";
        return response;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
      persistedThreads: ["thread-existing"],
    });
    const { client, request } = fixture;

    const binding = await startOrResumeThread({
      client,
      params,
    });

    const resumeParams = request.mock.calls.find(([method]) => method === "thread/resume")?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(request.mock.calls.map(([method]) => method)).toEqual(COLD_RESUME_METHODS);
    expect(resumeParams?.model).toBe("openai/gpt-oss-20b");
    expect(resumeParams?.modelProvider).toBe("lmstudio");
    expect(binding.threadId).toBe("thread-existing");
    expect(binding.modelProvider).toBe("lmstudio");
  });

  it("uses a transient Codex thread when runtime toolsAllow denies web_search", async () => {
    const { sessionFile, workspaceDir } = createPaths();
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;

    const fixture = await createSequentialLifecycleHarness(() => threadStartResult("thread-1"));
    const { client, request } = fixture;

    await startOrResumeThread({
      client,
      params,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      webSearchAllowed: true,
    });
    params.toolsAllow = ["message"];
    await fixture.endTurn("thread-1");
    const restrictedBinding = await startOrResumeThread({
      client,
      params,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      webSearchAllowed: false,
    });
    const savedAfterRestriction = await readCodexAppServerBinding(sessionFile);
    params.toolsAllow = undefined;
    await fixture.endTurn("thread-2");
    const resumedBinding = await startOrResumeThread({
      client,
      params,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      webSearchAllowed: true,
    });

    expect(restrictedBinding.threadId).toBe("thread-2");
    expect(restrictedBinding).not.toHaveProperty("liveThreadConfigFingerprint");
    expect(savedAfterRestriction?.threadId).toBe("thread-1");
    expect(resumedBinding.threadId).toBe("thread-1");
    expect(request.mock.calls.map(([method]) => method)).toEqual(
      twoStartsThenResumeMethods(PREFLIGHT_METHODS),
    );
    expect(request.mock.calls.find(([method]) => method === "thread/start")?.[1]).toMatchObject({
      config: { web_search: "cached" },
    });
    expect(
      request.mock.calls.filter(
        ([method]) => method === "thread/start" || method === "thread/resume",
      )[1]?.[1],
    ).toMatchObject({
      config: { web_search: "disabled" },
    });
  });

  it("keeps the retained primary subscribed across a transient report-only turn", async () => {
    const { sessionFile, workspaceDir } = createPaths();
    const params = createParams(sessionFile, workspaceDir);

    let starts = 0;
    const request = createLifecycleRequest(async (method: string, requestParams?: unknown) => {
      if (method === "thread/start") {
        starts += 1;
        return threadStartResult(`thread-${starts}`);
      }
      if (method === "thread/resume") {
        return threadStartResult((requestParams as { threadId: string }).threadId);
      }
      if (method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-report-only",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });

    const started = await startOrResumeThread({
      client,
      params,
    });
    await retainThread(client, started);
    params.delegationCapability = "report_only";
    const restrictedBinding = await startOrResumeThread({
      client,
      params,
    });
    const savedAfterRestriction = await readCodexAppServerBinding(sessionFile);
    params.delegationCapability = "full";
    const resumedBinding = await startOrResumeThread({
      client,
      params,
    });

    expect(restrictedBinding.threadId).toBe("thread-2");
    expect(restrictedBinding).not.toHaveProperty("liveThreadConfigFingerprint");
    expect(savedAfterRestriction?.threadId).toBe("thread-1");
    expect(resumedBinding.threadId).toBe("thread-1");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      ...PREFLIGHT_METHODS,
      "thread/start",
      ...PREFLIGHT_METHODS,
      "thread/start",
      ...PREFLIGHT_METHODS,
    ]);
    expect(
      request.mock.calls.filter(([method]) => method === "thread/start")[1]?.[1],
    ).toMatchObject({
      config: {
        "features.multi_agent": false,
        "features.multi_agent_v2": false,
      },
    });
  });

  it("preserves the native-search binding when provider capability support is unknown", async () => {
    const { sessionFile } = createPaths();

    const fixture = await createSequentialLifecycleHarness((requestParams) =>
      threadStartResult((requestParams as { threadId: string }).threadId),
    );
    const { client, request } = fixture;

    await startOrResumeThread({
      client,
      nativeProviderWebSearchSupport: "supported",
      webSearchAllowed: true,
    });
    await fixture.endTurn("thread-1");
    const transientBinding = await startOrResumeThread({
      client,
      nativeProviderWebSearchSupport: "unknown",
      webSearchAllowed: true,
    });
    const savedAfterUnknownSupport = await readCodexAppServerBinding(sessionFile);
    await fixture.endTurn("thread-2");
    const resumedBinding = await startOrResumeThread({
      client,
      nativeProviderWebSearchSupport: "supported",
      webSearchAllowed: true,
    });

    expect(transientBinding.threadId).toBe("thread-2");
    expect(transientBinding).not.toHaveProperty("liveThreadConfigFingerprint");
    expect(savedAfterUnknownSupport?.threadId).toBe("thread-1");
    expect(resumedBinding.threadId).toBe("thread-1");
    expect(request.mock.calls.map(([method]) => method)).toEqual(
      twoStartsThenResumeMethods(PREFLIGHT_METHODS),
    );
    expect(request.mock.calls.find(([method]) => method === "thread/start")?.[1]).toMatchObject({
      config: { web_search: "cached" },
    });
    expect(
      request.mock.calls.filter(
        ([method]) => method === "thread/start" || method === "thread/resume",
      )[1]?.[1],
    ).toMatchObject({
      config: { web_search: "disabled" },
    });
  });

  it("persists config-denied search when runtime toolsAllow also excludes web_search", async () => {
    const { sessionFile, workspaceDir } = createPaths();
    const params = createParams(sessionFile, workspaceDir);

    const fixture = await createSequentialLifecycleHarness((requestParams) =>
      threadStartResult((requestParams as { threadId: string }).threadId),
    );
    const { client, request } = fixture;

    await startOrResumeThread({
      client,
      params,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      persistentWebSearchAllowed: true,
      webSearchAllowed: true,
    });
    params.config = { tools: { deny: ["web_search"] } };
    params.toolsAllow = ["message"];
    await fixture.endTurn("thread-1");
    const restrictedBinding = await startOrResumeThread({
      client,
      params,
      nativeCodeModeEnabled: false,
      persistentWebSearchAllowed: false,
      webSearchAllowed: false,
    });
    await fixture.endTurn("thread-2");
    const resumedRestrictedBinding = await startOrResumeThread({
      client,
      params,
      nativeCodeModeEnabled: false,
      persistentWebSearchAllowed: false,
      webSearchAllowed: false,
    });

    expect(restrictedBinding.threadId).toBe("thread-2");
    expect(resumedRestrictedBinding.threadId).toBe("thread-2");
    expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe("thread-2");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      ...PREFLIGHT_METHODS,
      "thread/start",
      "thread/unsubscribe",
      "config/read",
      "thread/start",
      "thread/unsubscribe",
      "config/read",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
  });

  it("starts a fresh Codex thread for hosted search restrictions on a legacy binding", async () => {
    const { sessionFile, workspaceDir } = createPaths();
    await writeRawCodexAppServerBinding(sessionFile, {
      threadId: "thread-legacy",
      cwd: workspaceDir,
      model: "gpt-5.5",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.config = {
      tools: {
        web: {
          search: { openaiCodex: { allowedDomains: ["example.com"] } },
        },
      },
    };
    const request = createFixedThreadRequest("thread-fresh", ["thread/start"]);

    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
    });

    expect(binding.threadId).toBe("thread-fresh");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      ...PREFLIGHT_METHODS,
      "thread/start",
    ]);
    expect(request.mock.calls.find(([method]) => method === "thread/start")?.[1]).toMatchObject({
      config: {
        web_search: "cached",
        "tools.web_search.allowed_domains": ["example.com"],
      },
    });
  });

  it("starts a fresh Codex thread when dynamic tools switch from deferred to direct", async () => {
    let starts = 0;
    const request = createLifecycleRequest(async (method: string) => {
      if (method === "thread/start") {
        starts += 1;
        return threadStartResult(`thread-${starts}`);
      }
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
    });
    const binding = await startOrResumeThread({
      client: { request } as never,
      dynamicTools: [createNamedDynamicTool("web_search")],
    });

    expect(binding.threadId).toBe("thread-2");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      ...PREFLIGHT_METHODS,
      "thread/start",
      ...PREFLIGHT_METHODS,
      "thread/start",
    ]);
  });

  it("resumes a Codex thread when context-engine sidecar metadata is compatible", async () => {
    const { sessionFile, workspaceDir } = createPaths();
    const contextEngine = {
      schemaVersion: 1 as const,
      engineId: "lossless-claw",
      policyFingerprint:
        '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}',
    };
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      contextEngine,
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn(),
      compact: vi.fn(),
    } as never;
    params.contextTokenBudget = 400_000;

    const respond = createFixedThreadRequest("thread-existing", ["thread/resume"]);
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
      persistedThreads: ["thread-existing"],
    });
    const { client, request } = fixture;

    const binding = await startOrResumeThread({
      client,
      params,
    });

    expect(binding.threadId).toBe("thread-existing");
    expect(binding.lifecycle).toEqual({ action: "resumed" });
    expect(request.mock.calls.map(([method]) => method)).toEqual(COLD_RESUME_METHODS);
  });

  it("starts a fresh Codex thread when context-engine sidecar metadata is no longer active", async () => {
    const { sessionFile, workspaceDir } = createPaths();
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}',
      },
    });

    const request = createFixedThreadRequest("thread-fresh", ["thread/start"]);

    const binding = await startOrResumeThread({
      client: { request } as never,
    });

    expect(binding.threadId).toBe("thread-fresh");
    expect(binding.lifecycle).toEqual({
      action: "started",
      rotatedContextEngineBinding: true,
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      ...PREFLIGHT_METHODS,
      "thread/start",
    ]);
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.contextEngine).toBeUndefined();
  });

  it("keeps the previous dynamic tool fingerprint for transient no-tool maintenance turns", async () => {
    const { sessionFile } = createPaths();

    const fixture = await createSequentialLifecycleHarness(() => threadStartResult("thread-1"));
    const { client, request } = fixture;

    await startOrResumeThread({
      client,
      dynamicTools: [createDeferredNamedDynamicTool("message")],
    });
    const fingerprint = (await readCodexAppServerBinding(sessionFile))?.dynamicToolsFingerprint;
    await fixture.endTurn("thread-1");
    await startOrResumeThread({
      client,
    });
    await fixture.endTurn("thread-2");
    await startOrResumeThread({
      client,
      dynamicTools: [createDeferredNamedDynamicTool("message")],
    });

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.dynamicToolsFingerprint).toBe(fingerprint);
    expect(binding?.dynamicToolsContainDeferred).toBe(true);
    expect(binding?.threadId).toBe("thread-1");
    expect(request.mock.calls.map(([method]) => method)).toEqual(
      twoStartsThenResumeMethods(PREFLIGHT_METHODS),
    );
  });

  it("keeps the native binding isolated from a restricted replacement-tool turn", async () => {
    const { sessionFile, workspaceDir } = createPaths();
    const pluginAppPolicyContext = createPluginAppPolicyContext();
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      pluginAppsFingerprint: "plugin-apps-config-1",
      pluginAppsInputFingerprint: "plugin-apps-input-1",
      pluginAppPolicyContext,
    });

    const respond = createLifecycleRequest(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-transient");
      }
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
      persistedThreads: ["thread-existing"],
    });
    const { client, request } = fixture;
    const buildDenyAllPluginThreadConfig = vi.fn(async () => ({
      enabled: true,
      configPatch: {
        apps: {
          _default: {
            enabled: false,
            destructive_enabled: false,
            open_world_enabled: false,
          },
        },
      },
      fingerprint: "plugin-apps-deny-all",
      inputFingerprint: "plugin-apps-input-deny-all",
      policyContext: { fingerprint: "plugin-policy-deny-all", apps: {}, pluginAppIds: {} },
      diagnostics: [],
    }));
    const buildEnabledPluginThreadConfig = vi.fn(async () => ({
      enabled: true,
      configPatch: createPluginAppConfigPatch(),
      fingerprint: "plugin-apps-config-1",
      inputFingerprint: "plugin-apps-input-1",
      policyContext: pluginAppPolicyContext,
      diagnostics: [],
    }));

    await startOrResumeThread({
      client,
      dynamicTools: [createNamedDynamicTool("read"), createNamedDynamicTool("apply_patch")],
      nativeCodeModeEnabled: false,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-deny-all",
        enabledPluginConfigKeys: [],
        build: buildDenyAllPluginThreadConfig,
      },
    });
    const savedAfterDeny = await readCodexAppServerBinding(sessionFile);

    expect(savedAfterDeny?.threadId).toBe("thread-existing");
    expect(savedAfterDeny?.pluginAppsFingerprint).toBe("plugin-apps-config-1");
    expect(savedAfterDeny?.pluginAppsInputFingerprint).toBe("plugin-apps-input-1");

    await fixture.endTurn("thread-transient");
    await startOrResumeThread({
      client,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        enabledPluginConfigKeys: ["google-calendar"],
        build: buildEnabledPluginThreadConfig,
      },
    });

    expect(buildDenyAllPluginThreadConfig).toHaveBeenCalledTimes(1);
    const requestCalls = request.mock.calls;
    expect(requestCalls.map(([method]) => method)).toEqual([
      "config/read",
      "thread/start",
      "thread/unsubscribe",
      ...PREFLIGHT_METHODS,
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
    expect(requestCalls.find(([method]) => method === "thread/start")?.[1]).toMatchObject({
      dynamicTools: [
        expect.objectContaining({ name: "read" }),
        expect.objectContaining({ name: "apply_patch" }),
      ],
      environments: [],
    });
    expect(
      (requestCalls.find(([method]) => method === "thread/start")?.[1] as { config?: unknown })
        ?.config,
    ).toMatchObject({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
    });
    const savedAfterAllowed = await readCodexAppServerBinding(sessionFile);
    expect(savedAfterAllowed?.threadId).toBe("thread-existing");
    expect(savedAfterAllowed?.pluginAppsFingerprint).toBe("plugin-apps-config-1");
    expect(savedAfterAllowed?.pluginAppsInputFingerprint).toBe("plugin-apps-input-1");
    expect(savedAfterAllowed?.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("preserves the binding when the app-server closes during thread resume", async () => {
    const { sessionFile, workspaceDir } = createPaths();
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });

    const respond = createLifecycleRequest(async (method: string) => {
      if (method === "thread/resume") {
        fixture.client.close();
        return await new Promise(() => {});
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
      persistedThreads: ["thread-existing"],
    });
    const { client, request } = fixture;

    await expect(
      startOrResumeThread({
        client,
        params: createParams(sessionFile, workspaceDir),
      }),
    ).rejects.toThrow("codex app-server client is closed");

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      ...PREFLIGHT_METHODS,
      "thread/read",
      "thread/resume",
    ]);
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-existing");
  });

  it("starts a new thread when the network proxy config is not active on the binding", async () => {
    const { sessionFile, workspaceDir } = createPaths();
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const appServer = createNetworkProxyThreadLifecycleAppServerOptions();
    const request = createFixedThreadRequest("thread-network-proxy", ["thread/start"]);

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      appServer,
    });

    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual([...PREFLIGHT_METHODS, "thread/start"]);
    expect(requestCalls.find(([method]) => method === "thread/start")?.[1]).not.toHaveProperty(
      "sandbox",
    );
    expect(requestCalls.find(([method]) => method === "thread/start")?.[1].config).toMatchObject(
      appServer.networkProxy.configPatch,
    );
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-network-proxy");
    expect(binding?.networkProxyProfileName).toBe("openclaw-network");
    expect(binding?.networkProxyConfigFingerprint).toBe(appServer.networkProxy.configFingerprint);
  });

  it("replays compatible plugin app bindings on thread resume", async () => {
    const { workspaceDir } = createPaths();

    const appServer = {
      ...createThreadLifecycleAppServerOptions(),
      approvalsReviewer: "auto_review" as const,
    };
    const respond = vi.fn(async (method: string) => {
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "config/read") {
        return { config: {}, origins: {} };
      }
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-plugins");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;
    const basePolicyContext = createPluginAppPolicyContext();
    const pluginAppPolicyContext = {
      ...basePolicyContext,
      apps: {
        ...basePolicyContext.apps,
        "google-calendar-app": {
          ...basePolicyContext.apps["google-calendar-app"],
          destructiveApprovalMode: "ask" as const,
        },
      },
    };
    const askApprovalConfigPatch = createPluginAppConfigPatch({ approvalsReviewer: "user" });
    const buildPluginThreadConfig = vi.fn(async () => ({
      enabled: true,
      configPatch: askApprovalConfigPatch,
      fingerprint: "plugin-apps-config-1",
      inputFingerprint: "plugin-apps-input-1",
      policyContext: pluginAppPolicyContext,
      diagnostics: [],
    }));

    await startOrResumeThread({
      client,
      appServer,
      config: { "features.hooks": true },
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        build: buildPluginThreadConfig,
      },
    });
    await fixture.endTurn("thread-plugins");
    const binding = await startOrResumeThread({
      client,
      appServer,
      config: { "features.hooks": true },
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        enabledPluginConfigKeys: ["google-calendar"],
        build: buildPluginThreadConfig,
      },
    });

    expect(binding.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
    const requestCalls = request.mock.calls as unknown as Array<
      [string, { approvalsReviewer?: string; config?: unknown }]
    >;
    expect(requestCalls.map(([method]) => method)).toEqual(START_THEN_RESUME_METHODS);
    expect(request).toHaveBeenCalledWith(
      "config/read",
      { cwd: path.resolve(workspaceDir), includeLayers: true },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const threadRequests = requestCalls.filter(
      ([method]) => method === "thread/start" || method === "thread/resume",
    );
    expect(threadRequests.map(([, requestParams]) => requestParams.approvalsReviewer)).toEqual([
      "auto_review",
      "auto_review",
    ]);
    expect(threadRequests[0]?.[1].config).toEqual({
      "features.hooks": true,
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
      ...askApprovalConfigPatch,
    });
    expect(threadRequests[1]?.[1].config).toEqual({
      "features.hooks": true,
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
      ...askApprovalConfigPatch,
    });
  });

  it.each<{
    name: string;
    previousFingerprint: string;
    previousPolicyContext: PluginAppPolicyContext;
    configPatch: JsonObject;
    fingerprint: string;
    policyContext: PluginAppPolicyContext;
    enabledPluginConfigKeys: string[];
  }>([
    {
      name: "app inventory recovers for an empty binding",
      previousFingerprint: "plugin-apps-empty",
      previousPolicyContext: { fingerprint: "plugin-policy-empty", apps: {}, pluginAppIds: {} },
      configPatch: createPluginAppConfigPatch(),
      fingerprint: "plugin-apps-config-1",
      policyContext: createPluginAppPolicyContext(),
      enabledPluginConfigKeys: [],
    },
  ])("resumes with complete current plugin policy when $name", async (scenario) => {
    const { sessionFile, workspaceDir } = createPaths();
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      pluginAppsFingerprint: scenario.previousFingerprint,
      pluginAppsInputFingerprint: "plugin-apps-input-1",
      pluginAppPolicyContext: scenario.previousPolicyContext,
    });

    const respond = createLifecycleRequest(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-recovered");
      }
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
      persistedThreads: ["thread-existing"],
    });
    const { client, request } = fixture;
    const buildPluginThreadConfig = vi.fn(async () => ({
      enabled: true,
      configPatch: scenario.configPatch,
      fingerprint: scenario.fingerprint,
      inputFingerprint: "plugin-apps-input-1",
      policyContext: scenario.policyContext,
      diagnostics: [],
    }));

    await startOrResumeThread({
      client,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        enabledPluginConfigKeys: scenario.enabledPluginConfigKeys,
        build: buildPluginThreadConfig,
      },
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(COLD_RESUME_METHODS);
    expect(request.mock.calls.find(([method]) => method === "thread/resume")?.[1]).toEqual(
      expect.objectContaining({
        config: { ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG, ...scenario.configPatch },
      }),
    );
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-existing",
      pluginAppsFingerprint: scenario.fingerprint,
      pluginAppPolicyContext: scenario.policyContext,
    });
  });

  it("starts a new configured thread for legacy bindings missing plugin app metadata", async () => {
    const { sessionFile, workspaceDir } = createPaths();
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });

    const request = createFixedThreadRequest("thread-plugins", ["thread/start"]);
    const pluginAppPolicyContext = createPluginAppPolicyContext();

    await startOrResumeThread({
      client: { request } as never,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        build: async () => ({
          enabled: true,
          configPatch: createPluginAppConfigPatch(),
          fingerprint: "plugin-apps-config-1",
          inputFingerprint: "plugin-apps-input-1",
          policyContext: pluginAppPolicyContext,
          diagnostics: [],
        }),
      },
    });

    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual([...PREFLIGHT_METHODS, "thread/start"]);
    expect(requestCalls.find(([method]) => method === "thread/start")?.[1].config).toEqual({
      ...createPluginAppConfigPatch(),
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
    });
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-plugins");
    expect(binding?.pluginAppsFingerprint).toBe("plugin-apps-config-1");
    expect(binding?.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("preserves the bound auth profile when resume params omit authProfileId", async () => {
    const { sessionFile, workspaceDir } = createPaths();
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      authProfileId: "openai:bound",
    });
    const params = createParams(sessionFile, workspaceDir);
    delete params.authProfileId;
    params.agentDir = path.join(tempDir, "agent");
    params.authProfileStore = {
      version: 1,
      profiles: {
        "openai:bound": {
          type: "oauth",
          provider: "openai",
          access: "scoped-access",
          refresh: "scoped-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };

    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: params.agentDir,
      persistedThreads: ["thread-existing"],
      respond: async (method) => {
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/resume") {
          return threadStartResult("thread-existing");
        }
        throw new Error(`unexpected method: ${method}`);
      },
    });
    const binding = await startOrResumeThread({
      client: fixture.client,
      params,
      appServer: {
        start: {
          transport: "stdio",
          command: "codex",
          args: ["app-server"],
          headers: {},
        },
        codeModeOnly: false,
        loopDetectionPreToolUseRelay: true,
        requestTimeoutMs: 60_000,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        connectionClass: "local-loopback",
      },
    });

    expect(binding.authProfileId).toBe("openai:bound");
    expect(binding.modelProvider).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
