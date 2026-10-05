import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  hashCodexAppServerBindingFingerprint,
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  seedCodexTestBinding,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import {
  createAppServerOptions,
  createLeasedCodexLifecycleHarness,
  createParams,
  startOrResumeThread,
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
  return vi.fn(async (method: string, params: unknown) => {
    if (method === "config/read") {
      return { config: {}, origins: {}, layers: [] };
    }
    if (method === "configRequirements/read") {
      return { requirements: null };
    }
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

function lifecycleOptions(
  sessionFile: string,
  cwd: string,
  config?: EmbeddedRunAttemptParams["config"],
) {
  return {
    params: createParams(sessionFile, cwd, config),
    cwd,
    dynamicTools: [],
    appServer: createAppServerOptions(),
  };
}

describe("startOrResumeThread — user mcp.servers projection (regression: #80814)", () => {
  setupUserMcpServerTestHooks();

  it("projects wildcard filters as exact names before thread/start and thread/resume", async () => {
    const sessionFile = path.join(tempDir, "policy-session.jsonl");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    const workspaceDir = path.join(tempDir, "workspace");
    const serverPath = await writePolicyProbeServer(tempDir);
    const config: EmbeddedRunAttemptParams["config"] = {
      tools: { allow: ["docs__*"] },
      mcp: {
        servers: {
          docs: {
            transport: "stdio",
            command: process.execPath,
            args: [serverPath],
            toolFilter: { exclude: ["delete_*"] },
          },
        },
      },
    };
    const request = createRequest("thread-policy");
    let wire = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond: request,
    });
    const run = async () =>
      await startOrResumeThread({
        client: wire.client,
        ...lifecycleOptions(sessionFile, workspaceDir, config),
      });

    await run();
    await wire.client.closeAndWait();
    wire = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond: request,
      persistedThreads: ["thread-policy"],
    });
    await run();

    expect(wire.request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);

    for (const method of ["thread/start", "thread/resume"]) {
      const call = request.mock.calls.find(([candidate]) => candidate === method);
      const callParams = call?.[1] as {
        config?: {
          mcp_servers?: { docs?: { enabled_tools?: string[]; disabled_tools?: string[] } };
        };
      };
      expect(callParams?.config?.mcp_servers?.docs).toMatchObject({
        command: process.execPath,
        args: [serverPath],
        enabled_tools: ["read_docs"],
        disabled_tools: ["app_docs", "delete_docs", "task_docs"],
      });
      expect(JSON.stringify(callParams?.config?.mcp_servers?.docs)).not.toContain("delete_*");
    }
  });

  it("keeps session MCP denials additive in thread/start before the turn", async () => {
    const sessionFile = path.join(tempDir, "policy-session-override.jsonl");
    registerCodexTestSessionIdentity(
      sessionFile,
      "session-override",
      "agent:main:session-override",
    );
    const workspaceDir = path.join(tempDir, "workspace-override");
    const serverPath = await writePolicyProbeServer(tempDir);
    const config: EmbeddedRunAttemptParams["config"] = {
      tools: { allow: ["docs__*"] },
      mcp: {
        servers: {
          docs: { transport: "stdio", command: process.execPath, args: [serverPath] },
        },
      },
    };
    const request = createRequest("thread-session-override");
    const run: EmbeddedRunAttemptParams = {
      ...createParams(sessionFile, workspaceDir, config),
      toolOverrides: { mcpToolsDeny: { docs: ["delete_docs"] } },
    };

    await startOrResumeThread({
      client: { request } as never,
      params: run,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    const callParams = request.mock.calls.find(([method]) => method === "thread/start")?.[1] as {
      config?: { mcp_servers?: { docs?: { enabled_tools?: string[]; disabled_tools?: string[] } } };
    };
    expect(callParams.config?.mcp_servers?.docs).toMatchObject({
      enabled_tools: ["read_docs"],
      disabled_tools: ["app_docs", "delete_docs", "task_docs"],
    });
  });

  it("projects only the current agent's MCP servers without starting excluded servers", async () => {
    const sessionFile = path.join(tempDir, "agent-scope-session.jsonl");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:atlas:session-1");
    const workspaceDir = path.join(tempDir, "workspace-scope");
    const serverPath = await writePolicyProbeServer(tempDir);
    const startedPath = path.join(tempDir, "excluded-server-started");
    const url = await startPolicyHttpServer();
    const config: EmbeddedRunAttemptParams["config"] = {
      tools: { deny: ["docs__delete_docs"] },
      mcp: {
        servers: {
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
      },
    };
    const request = createRequest("thread-agent-scope");

    await startOrResumeThread({
      client: { request } as never,
      params: {
        ...createParams(sessionFile, workspaceDir, config),
        sessionKey: "agent:atlas:session-1",
      },
      agentId: "atlas",
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    await expect(fs.access(startedPath)).rejects.toMatchObject({ code: "ENOENT" });
    const callParams = request.mock.calls.find(([method]) => method === "thread/start")?.[1] as {
      config?: { mcp_servers?: Record<string, unknown> };
    };
    expect(callParams.config?.mcp_servers).toStrictEqual({
      atlas: { url, default_tools_approval_mode: "approve", enabled_tools: ["read_docs"] },
    });
  });

  it("restarts a beta5 MCP binding stored as a raw fingerprint before converging", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    const workspaceDir = path.join(tempDir, "workspace");
    const authorization = "Bearer beta5-access-token";
    const url = await startPolicyHttpServer();
    const config = {
      mcp: {
        servers: {
          ducktape: {
            transport: "streamable-http",
            url,
            headers: {
              Authorization: authorization,
              "x-tenant": "keep",
            },
          },
        },
      },
    } as unknown as EmbeddedRunAttemptParams["config"];
    const request = createRequest("thread-beta5");
    let wire = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond: request,
    });
    const run = () =>
      startOrResumeThread({
        client: wire.client,
        ...lifecycleOptions(sessionFile, workspaceDir, config),
      });

    await run();
    const currentBinding = await readCodexAppServerBinding(sessionFile);
    expect(currentBinding).toBeDefined();
    expect(currentBinding?.threadId).toBe("thread-beta5");

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
    await run();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/start",
    ]);
    const convergedBinding = await readCodexAppServerBinding(sessionFile);
    expect(convergedBinding?.threadId).toBe("thread-beta5-2");
    expect(convergedBinding?.threadId).not.toBe(currentBinding?.threadId);
    expect(convergedBinding?.userMcpServersFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(convergedBinding?.userMcpServersFingerprint).not.toContain("beta5-access-token");
    expect(convergedBinding?.userMcpServersFingerprint).not.toBe(legacyFingerprint);
    expect(convergedBinding?.userMcpServersFingerprint).not.toBe(
      hashCodexAppServerBindingFingerprint(legacyFingerprint),
    );

    await wire.client.closeAndWait();
    wire = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond: request,
      persistedThreads: ["thread-beta5-2"],
    });
    request.mockClear();
    await run();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/resume",
    ]);
    expect(wire.request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
    expect(request).toHaveBeenCalledWith(
      "thread/resume",
      expect.objectContaining({ threadId: convergedBinding?.threadId }),
    );
    expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe(
      convergedBinding?.threadId,
    );
  });

  it("preserves MCP-mismatched bindings for transient unknown-search-support turns", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
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
    await startOrResumeThread({
      client: { request } as never,
      ...lifecycleOptions(sessionFile, workspaceDir),
      mcpServersFingerprint: undefined,
      mcpServersFingerprintEvaluated: true,
      userMcpServersEnabled: false,
      nativeProviderWebSearchSupport: "unknown",
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/start",
    ]);
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-native",
      mcpServersFingerprint: "mcp-v1",
    });
  });

  it("starts a new thread when a user MCP Authorization bearer changes without storing the bearer", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    const workspaceDir = path.join(tempDir, "workspace");
    const url = await startPolicyHttpServer();
    const createConfig = (authorization: string) =>
      ({
        mcp: {
          servers: {
            ducktape: {
              transport: "streamable-http",
              url,
              headers: {
                Authorization: authorization,
                "x-tenant": "keep",
              },
            },
          },
        },
      }) as unknown as EmbeddedRunAttemptParams["config"];
    const request = createRequest("thread-with-current-bearer");

    await startOrResumeThread({
      client: { request } as never,
      ...lifecycleOptions(sessionFile, workspaceDir, createConfig("Bearer access-token-one")),
    });
    const firstBinding = await readCodexAppServerBinding(sessionFile);
    expect(firstBinding?.threadId).toBe("thread-with-current-bearer");
    expect(firstBinding?.userMcpServersFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(firstBinding?.userMcpServersFingerprint).not.toContain("access-token-one");

    request.mockClear();

    await startOrResumeThread({
      client: { request } as never,
      ...lifecycleOptions(sessionFile, workspaceDir, createConfig("Bearer access-token-two")),
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/start",
    ]);
    const startParams = request.mock.calls[2]?.[1] as {
      config?: { mcp_servers?: Record<string, { http_headers?: Record<string, string> }> };
    };
    expect(startParams?.config?.mcp_servers?.ducktape?.http_headers?.Authorization).toBe(
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
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    let mcpRequestCount = 0;
    const mcpServer = http.createServer((_request, response) => {
      mcpRequestCount += 1;
      response.writeHead(401).end();
    });
    await new Promise<void>((resolve) => {
      mcpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = mcpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback MCP server address");
    }
    const request = createRequest("thread-without-oauth-mcp");

    try {
      await startOrResumeThread({
        client: { request } as never,
        params: createParams(sessionFile, workspaceDir, {
          tools: { deny: ["ducktape__restricted"] },
          mcp: {
            servers: {
              ducktape: {
                transport: "streamable-http",
                url: `http://127.0.0.1:${address.port}/mcp`,
                auth: "oauth",
              },
            },
          },
        } as unknown as EmbeddedRunAttemptParams["config"]),
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: {
          ...createAppServerOptions(),
          connectionClass: "remote",
        },
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        mcpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }

    const startParams = request.mock.calls.find(([method]) => method === "thread/start")?.[1] as {
      config?: { mcp_servers?: Record<string, unknown> };
    };
    expect(startParams?.config?.mcp_servers).toBeUndefined();
    expect(mcpRequestCount).toBe(0);
  });
});
