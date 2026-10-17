import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import {
  hashCodexAppServerBindingFingerprint,
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  seedCodexTestBinding,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import {
  createAppServerOptions,
  createLifecycleRequest,
  createLeasedCodexLifecycleHarness,
  createParams,
  startOrResumeThreadWithoutSkills as startOrResumeThread,
  threadResumeResult,
  threadStartResult,
} from "./thread-lifecycle.test-fixtures.js";
import {
  setupUserMcpServerTestHooks,
  startPolicyHttpServer,
  tempDir,
  writePolicyProbeServer,
} from "./thread-lifecycle.user-mcp-servers.test-support.js";

function createRequest(startThreadId: string) {
  let startCount = 0;
  return createLifecycleRequest(async (method, params) => {
    if (method === "thread/start") {
      startCount += 1;
      return threadStartResult(startCount === 1 ? startThreadId : `${startThreadId}-${startCount}`);
    }
    if (method === "thread/resume") {
      assert(
        params !== null &&
          typeof params === "object" &&
          "threadId" in params &&
          typeof params.threadId === "string",
      );
      return threadResumeResult(params.threadId);
    }
    throw new Error(`unexpected method: ${method}`);
  });
}

type Config = NonNullable<EmbeddedRunAttemptParams["config"]>;
function mcpConfig(
  servers: NonNullable<Config["mcp"]>["servers"],
  tools?: Config["tools"],
): Config {
  return { mcp: { servers }, tools };
}

function bearerConfig(url: string, authorization: string) {
  return mcpConfig({
    ducktape: {
      transport: "streamable-http",
      url,
      headers: { Authorization: authorization, "x-tenant": "keep" },
    },
  });
}

function projectedServers(request: ReturnType<typeof createRequest>, method = "thread/start") {
  const params = request.mock.calls.find(([candidate]) => candidate === method)?.[1] as
    | {
        config?: {
          mcp_servers?: Record<string, { http_headers?: Record<string, string> }>;
        };
      }
    | undefined;
  return params?.config?.mcp_servers;
}

describe("startOrResumeThread — user mcp.servers projection (regression: #80814)", () => {
  setupUserMcpServerTestHooks();
  let sessionFile: string;
  let workspaceDir: string;
  beforeEach(() => {
    sessionFile = path.join(tempDir, "session.jsonl");
    workspaceDir = path.join(tempDir, "workspace");
  });

  function expectMethods(request: ReturnType<typeof createRequest>, ...methods: string[]) {
    expect(request.mock.calls.map(([method]) => method)).toEqual(methods);
  }

  function run(
    request: ReturnType<typeof createRequest>,
    config?: EmbeddedRunAttemptParams["config"],
    overrides: Partial<Parameters<typeof startOrResumeThread>[0]> = {},
  ) {
    return startOrResumeThread({
      client: { request } as never,
      params: overrides.params ?? {
        ...createParams(sessionFile, workspaceDir, config),
        disableTools: false,
      },
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
      ...overrides,
    });
  }

  async function session(startThreadId: string, config: EmbeddedRunAttemptParams["config"]) {
    const request = createRequest(startThreadId);
    const connect = (persistedThreads?: string[]) =>
      createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond: request,
        persistedThreads,
      });
    let wire = await connect();
    return {
      request,
      get wire() {
        return wire;
      },
      run: () => run(request, config, { client: wire.client }),
      reconnect: async (threadId: string) => {
        await wire.client.closeAndWait();
        wire = await connect([threadId]);
      },
    };
  }

  it("projects wildcard filters as exact names before thread/start and thread/resume", async () => {
    sessionFile = path.join(tempDir, "policy-session.jsonl");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    const serverPath = await writePolicyProbeServer(tempDir);
    const config = mcpConfig(
      {
        docs: {
          transport: "stdio",
          command: process.execPath,
          args: [serverPath],
          toolFilter: { exclude: ["delete_*"] },
        },
      },
      { allow: ["docs__*"] },
    );
    const fixture = await session("thread-policy", config);
    await fixture.run();
    await fixture.reconnect("thread-policy");
    await fixture.run();
    expectMethods(
      fixture.wire.request,
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    );

    for (const method of ["thread/start", "thread/resume"]) {
      const docs = projectedServers(fixture.request, method)?.docs;
      expect(docs).toMatchObject({
        command: process.execPath,
        args: [serverPath],
        enabled_tools: ["read_docs"],
        disabled_tools: ["app_docs", "delete_docs", "task_docs"],
      });
      expect(JSON.stringify(docs)).not.toContain("delete_*");
    }
  });

  it("keeps session MCP denials additive in thread/start before the turn", async () => {
    sessionFile = path.join(tempDir, "policy-session-override.jsonl");
    registerCodexTestSessionIdentity(
      sessionFile,
      "session-override",
      "agent:main:session-override",
    );
    workspaceDir = path.join(tempDir, "workspace-override");
    const serverPath = await writePolicyProbeServer(tempDir);
    const config = mcpConfig(
      { docs: { transport: "stdio", command: process.execPath, args: [serverPath] } },
      { allow: ["docs__*"] },
    );
    const request = createRequest("thread-session-override");
    const params: EmbeddedRunAttemptParams = {
      ...createParams(sessionFile, workspaceDir, config),
      toolOverrides: { mcpToolsDeny: { docs: ["delete_docs"] } },
    };

    await run(request, config, { params });

    expect(projectedServers(request)?.docs).toMatchObject({
      enabled_tools: ["read_docs"],
      disabled_tools: ["app_docs", "delete_docs", "task_docs"],
    });
  });

  it("projects only the current agent's MCP servers without starting excluded servers", async () => {
    sessionFile = path.join(tempDir, "agent-scope-session.jsonl");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:atlas:session-1");
    workspaceDir = path.join(tempDir, "workspace-scope");
    const serverPath = await writePolicyProbeServer(tempDir);
    const startedPath = path.join(tempDir, "excluded-server-started");
    const url = await startPolicyHttpServer();
    const config = mcpConfig(
      {
        atlas: {
          transport: "streamable-http",
          url,
          codex: { agents: ["atlas"], defaultToolsApprovalMode: "approve" },
        },
        docs: {
          transport: "stdio",
          command: process.execPath,
          args: [serverPath],
          env: { OPENCLAW_POLICY_PROBE_STARTED: startedPath },
          codex: { agents: ["worker"] },
        },
      },
      { deny: ["docs__delete_docs"] },
    );
    const request = createRequest("thread-agent-scope");

    await run(request, config, {
      params: {
        ...createParams(sessionFile, workspaceDir, config),
        sessionKey: "agent:atlas:session-1",
      },
      agentId: "atlas",
    });

    await expect(fs.access(startedPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(projectedServers(request)).toStrictEqual({
      atlas: { url, default_tools_approval_mode: "approve", enabled_tools: ["read_docs"] },
    });
  });

  it("restarts a beta5 MCP binding stored as a raw fingerprint before converging", async () => {
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    const authorization = "Bearer beta5-access-token";
    const url = await startPolicyHttpServer();
    const config = bearerConfig(url, authorization);
    const fixture = await session("thread-beta5", config);
    const { request, run: runSession } = fixture;
    await runSession();
    const currentBinding = await readCodexAppServerBinding(sessionFile);
    expect(currentBinding).toMatchObject({ threadId: "thread-beta5" });

    const legacyFingerprint = JSON.stringify({
      mcp_servers: {
        ducktape: {
          http_headers: {
            Authorization: authorization,
            "x-tenant": "keep",
          },
          url,
        },
      },
    });
    seedCodexTestBinding(sessionFile, {
      ...currentBinding!,
      userMcpServersFingerprint: legacyFingerprint,
    });

    request.mockClear();
    await runSession();
    expectMethods(request, "config/read", "configRequirements/read", "thread/start");
    const convergedBinding = await readCodexAppServerBinding(sessionFile);
    expect(convergedBinding?.threadId).toBe("thread-beta5-2");
    expect(convergedBinding?.threadId).not.toBe(currentBinding?.threadId);
    expect(convergedBinding?.userMcpServersFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(convergedBinding?.userMcpServersFingerprint).not.toContain("beta5-access-token");
    expect(convergedBinding?.userMcpServersFingerprint).not.toBe(legacyFingerprint);
    expect(convergedBinding?.userMcpServersFingerprint).not.toBe(
      hashCodexAppServerBindingFingerprint(legacyFingerprint),
    );

    await fixture.reconnect("thread-beta5-2");
    request.mockClear();
    await runSession();
    expectMethods(request, "config/read", "configRequirements/read", "thread/resume");
    expectMethods(
      fixture.wire.request,
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    );
    expect(request).toHaveBeenCalledWith(
      "thread/resume",
      expect.objectContaining({ threadId: convergedBinding?.threadId }),
    );
    expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe(
      convergedBinding?.threadId,
    );
  });

  it("preserves MCP-mismatched bindings for transient unknown-search-support turns", async () => {
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-native",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      mcpServersFingerprint: "mcp-v1",
      webSearchThreadConfigFingerprint: "web-search-v1",
    });
    const request = createRequest("thread-transient");
    await run(request, undefined, {
      mcpServersFingerprint: undefined,
      mcpServersFingerprintEvaluated: true,
      userMcpServersEnabled: false,
      nativeProviderWebSearchSupport: "unknown",
    });
    expectMethods(request, "config/read", "configRequirements/read", "thread/start");
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-native",
      mcpServersFingerprint: "mcp-v1",
    });
  });

  it("starts a new thread when a user MCP Authorization bearer changes without storing the bearer", async () => {
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    const url = await startPolicyHttpServer();
    const request = createRequest("thread-with-current-bearer");
    await run(request, bearerConfig(url, "Bearer access-token-one"));
    const firstBinding = await readCodexAppServerBinding(sessionFile);
    expect(firstBinding?.threadId).toBe("thread-with-current-bearer");
    expect(firstBinding?.userMcpServersFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(firstBinding?.userMcpServersFingerprint).not.toContain("access-token-one");

    request.mockClear();
    await run(request, bearerConfig(url, "Bearer access-token-two"));
    expectMethods(request, "config/read", "configRequirements/read", "thread/start");
    expect(projectedServers(request)?.ducktape?.http_headers?.Authorization).toBe(
      "Bearer access-token-two",
    );
    const secondBinding = await readCodexAppServerBinding(sessionFile);
    expect(secondBinding?.threadId).toBe("thread-with-current-bearer-2");
    expect(secondBinding?.threadId).not.toBe(firstBinding?.threadId);
    expect(secondBinding?.userMcpServersFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(secondBinding?.userMcpServersFingerprint).not.toContain("access-token-two");
    expect(secondBinding?.userMcpServersFingerprint).not.toBe(
      firstBinding?.userMcpServersFingerprint,
    );
  });

  it("omits MCP OAuth servers before policy discovery for a remote app-server", async () => {
    let mcpRequestCount = 0;
    const mcpServer = http.createServer((_request, response) => {
      mcpRequestCount += 1;
      response.writeHead(401).end();
    });
    await once(mcpServer.listen(0, "127.0.0.1"), "listening");
    const address = mcpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback MCP server address");
    }
    const request = createRequest("thread-without-oauth-mcp");

    try {
      await run(request, undefined, {
        params: createParams(
          sessionFile,
          workspaceDir,
          mcpConfig(
            {
              ducktape: {
                transport: "streamable-http",
                url: `http://127.0.0.1:${address.port}/mcp`,
                auth: "oauth",
              },
            },
            { deny: ["ducktape__restricted"] },
          ),
        ),
        appServer: {
          ...createAppServerOptions(),
          connectionClass: "remote",
        },
      });
    } finally {
      await promisify(mcpServer.close.bind(mcpServer))();
    }

    expect(projectedServers(request)).toBeUndefined();
    expect(mcpRequestCount).toBe(0);
  });
});
