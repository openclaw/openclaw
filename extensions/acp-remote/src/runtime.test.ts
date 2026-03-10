import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { runAcpRuntimeAdapterContract } from "../../../src/acp/runtime/adapter-contract.testkit.js";
import { ACP_REMOTE_PROTOCOL_VERSION } from "./config.js";
import { AcpRemoteRuntime, decodeAcpRemoteHandleState } from "./runtime.js";

type RpcRequest = {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type CapturedRequest = {
  headers: IncomingHttpHeaders;
  request: RpcRequest;
};

class MockAcpRemoteGateway {
  private readonly server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as RpcRequest;
    this.requests.push({
      headers: req.headers,
      request,
    });

    const writeJson = (message: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(message));
    };

    const beginSse = () => {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    };

    const writeSse = (message: unknown) => {
      res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    };

    if (request.method === "initialize") {
      writeJson({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: this.protocolVersion,
          agentCapabilities: {
            loadSession: this.loadSession,
            promptCapabilities: {
              image: false,
              audio: false,
              embeddedContext: false,
            },
            mcpCapabilities: {
              http: false,
              sse: false,
            },
            sessionCapabilities: {},
          },
          authMethods: [],
          agentInfo: {
            name: "mock-acp-gateway",
            version: "test",
          },
        },
      });
      return;
    }

    if (request.method === "session/load") {
      const sessionId = String(request.params?.sessionId ?? "");
      this.loadCalls.push(sessionId);
      if (!this.sessions.has(sessionId)) {
        writeJson({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: "session_not_found",
            message: `session ${sessionId} not found`,
            data: {
              reason: "session_not_found",
            },
          },
        });
        return;
      }
      beginSse();
      const session = this.sessions.get(sessionId);
      const requestedCwd =
        typeof request.params?.cwd === "string" && request.params.cwd.trim()
          ? request.params.cwd.trim()
          : undefined;
      if (session && requestedCwd) {
        session.cwd = requestedCwd;
      }
      if (session?.history.length) {
        for (const notification of session.history) {
          writeSse(notification);
        }
      }
      writeSse({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          cwd: session?.cwd,
          modes: session?.currentModeId
            ? {
                currentModeId: session.currentModeId,
                availableModes: [
                  { id: "prompt", name: "Prompt" },
                  { id: "steer", name: "Steer" },
                  { id: "contract", name: "Contract" },
                ],
              }
            : undefined,
          configOptions: Object.entries(session?.configOptions ?? {}).map(([id, currentValue]) => ({
            type: "select",
            id,
            name: id,
            currentValue,
            options: [],
          })),
        },
      });
      res.end();
      return;
    }

    if (request.method === "session/new") {
      const sessionId = String(request.params?._meta?.openclawSessionId ?? "");
      const cwd =
        typeof request.params?.cwd === "string" && request.params.cwd.trim()
          ? request.params.cwd.trim()
          : this.fallbackCwd;
      this.newCalls.push(sessionId);
      this.sessions.set(sessionId, {
        cwd,
        currentModeId: undefined,
        configOptions: {},
        history: [],
      });
      writeJson({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          sessionId,
          cwd,
        },
      });
      return;
    }

    if (request.method === "session/set_mode") {
      const sessionId = String(request.params?.sessionId ?? "");
      const modeId = String(request.params?.modeId ?? "");
      this.setModeCalls.push({ sessionId, modeId });
      const session = this.sessions.get(sessionId);
      if (session) {
        session.currentModeId = modeId;
      }
      writeJson({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          modes: {
            currentModeId: modeId,
            availableModes: [
              { id: "prompt", name: "Prompt" },
              { id: "steer", name: "Steer" },
              { id: "contract", name: "Contract" },
            ],
          },
        },
      });
      return;
    }

    if (request.method === "session/set_config_option") {
      const sessionId = String(request.params?.sessionId ?? "");
      const configId = String(request.params?.configId ?? "");
      const value = String(request.params?.value ?? "");
      this.setConfigCalls.push({ sessionId, configId, value });
      const session = this.sessions.get(sessionId);
      if (session) {
        session.configOptions[configId] = value;
      }
      writeJson({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          configOptions: [
            {
              type: "select",
              id: configId,
              name: configId,
              currentValue: value,
              options: [],
            },
          ],
        },
      });
      return;
    }

    if (request.method === "session/close") {
      const sessionId = String(request.params?.sessionId ?? "");
      this.closeCalls.push(sessionId);
      this.sessions.delete(sessionId);
      writeJson({
        jsonrpc: "2.0",
        id: request.id,
        result: {},
      });
      return;
    }

    if (request.method === "session/cancel") {
      const sessionId = String(request.params?.sessionId ?? "");
      this.cancelCalls.push(sessionId);
      res.writeHead(202);
      res.end();
      return;
    }

    if (request.method === "session/prompt") {
      beginSse();
      const sessionId = String(request.params?.sessionId ?? "");
      const prompt = request.params?.prompt;
      const text =
        Array.isArray(prompt) && prompt[0] && typeof prompt[0] === "object"
          ? String((prompt[0] as { text?: unknown }).text ?? "")
          : "";
      const requestId = String(request.params?._meta?.openclawRequestId ?? request.id ?? "");
      const attempt = (this.promptAttempts.get(requestId) ?? 0) + 1;
      this.promptAttempts.set(requestId, attempt);

      const stored =
        this.promptResults.get(requestId) ??
        (() => {
          const result = {
            notifications: [
              {
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId,
                  update: {
                    sessionUpdate: "agent_thought_chunk",
                    content: {
                      type: "text",
                      text: "thinking",
                    },
                  },
                },
              },
              {
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId,
                  update: {
                    sessionUpdate: "tool_call",
                    toolCallId: "tool-1",
                    title: "inspect",
                    status: "in_progress",
                  },
                },
              },
              {
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: {
                      type: "text",
                      text: `echo:${text}`,
                    },
                  },
                },
              },
            ],
            terminal: {
              jsonrpc: "2.0",
              id: request.id,
              result: {
                stopReason: "end_turn",
              },
            },
          };
          this.promptResults.set(requestId, result);
          return result;
        })();

      const session = this.sessions.get(sessionId);
      if (session) {
        session.history.push(...stored.notifications);
      }
      for (const notification of stored.notifications) {
        writeSse(notification);
      }
      if (this.dropFirstPromptAttempt && attempt === 1) {
        res.end();
        return;
      }
      writeSse(stored.terminal);
      res.end();
      return;
    }

    writeJson({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32_600,
        message: `unsupported method: ${String(request.method)}`,
      },
    });
  });

  protocolVersion = ACP_REMOTE_PROTOCOL_VERSION;
  loadSession = true;
  dropFirstPromptAttempt = false;
  fallbackCwd = "/home/remote";
  readonly sessions = new Map<
    string,
    {
      cwd: string;
      currentModeId?: string;
      configOptions: Record<string, string>;
      history: unknown[];
    }
  >();
  readonly requests: CapturedRequest[] = [];
  readonly promptAttempts = new Map<string, number>();
  readonly promptResults = new Map<
    string,
    {
      notifications: unknown[];
      terminal: unknown;
    }
  >();
  readonly loadCalls: string[] = [];
  readonly newCalls: string[] = [];
  readonly cancelCalls: string[] = [];
  readonly closeCalls: string[] = [];
  readonly setModeCalls: Array<{ sessionId: string; modeId: string }> = [];
  readonly setConfigCalls: Array<{ sessionId: string; configId: string; value: string }> = [];

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}/acp`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

const servers: MockAcpRemoteGateway[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await server.stop();
    }
  }
});

async function createRuntime(
  params: {
    gateway?: MockAcpRemoteGateway;
    config?: { defaultCwd?: string };
  } = {},
) {
  const gateway = params.gateway ?? new MockAcpRemoteGateway();
  const url = await gateway.start();
  servers.push(gateway);
  const runtime = new AcpRemoteRuntime({
    url,
    defaultCwd: params.config?.defaultCwd,
    headers: {},
    timeoutMs: 5_000,
    retryDelayMs: 1,
    protocolVersion: ACP_REMOTE_PROTOCOL_VERSION,
  });
  return { runtime, gateway };
}

describe("AcpRemoteRuntime", () => {
  it("passes the shared ACP adapter contract suite", async () => {
    const { runtime, gateway } = await createRuntime();

    await runAcpRuntimeAdapterContract({
      createRuntime: async () => runtime,
      agentId: "codex",
      successPrompt: "contract-pass",
      includeControlChecks: true,
    });

    expect(gateway.newCalls.length).toBe(1);
    expect(gateway.setModeCalls).toEqual([
      expect.objectContaining({
        modeId: "contract",
      }),
    ]);
    expect(gateway.setConfigCalls).toEqual([
      expect.objectContaining({
        configId: "contract_key",
        value: "contract_value",
      }),
    ]);
    expect(gateway.cancelCalls.length).toBeGreaterThanOrEqual(1);
    expect(gateway.closeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("reopens sessions with a stable lease identity derived from the session key", async () => {
    const { runtime, gateway } = await createRuntime();

    const first = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:stable",
      agent: "codex",
      mode: "persistent",
      cwd: "/home/test/workspace",
    });
    const decoded = decodeAcpRemoteHandleState(first.runtimeSessionName);

    expect(first.backendSessionId).toBe("agent:codex:acp:stable");
    expect(decoded?.sessionId).toBe("agent:codex:acp:stable");
    expect(gateway.newCalls).toEqual(["agent:codex:acp:stable"]);

    await runtime.ensureSession({
      sessionKey: "agent:codex:acp:stable",
      agent: "codex",
      mode: "persistent",
      cwd: "/home/test/workspace",
    });

    const loadRequests = gateway.requests.filter(
      (entry) => entry.request.method === "session/load" || entry.request.method === "session/new",
    );
    const clientIds = loadRequests.map((entry) =>
      String(
        (entry.request.params?._meta as { openclawClientId?: unknown } | undefined)
          ?.openclawClientId ?? "",
      ),
    );

    expect(gateway.loadCalls).toEqual(["agent:codex:acp:stable", "agent:codex:acp:stable"]);
    expect(gateway.newCalls).toEqual(["agent:codex:acp:stable"]);
    expect(new Set(clientIds)).toEqual(new Set([decoded?.clientId]));
  });

  it("uses configured defaultCwd when callers omit cwd", async () => {
    const { runtime, gateway } = await createRuntime({
      config: {
        defaultCwd: "/srv/openclaw",
      },
    });

    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:default-cwd",
      agent: "codex",
      mode: "persistent",
    });
    const decoded = decodeAcpRemoteHandleState(handle.runtimeSessionName);
    const sessionLoadRequest = gateway.requests.find(
      (entry) => entry.request.method === "session/load",
    );
    const sessionNewRequest = gateway.requests.find(
      (entry) => entry.request.method === "session/new",
    );

    expect(sessionLoadRequest?.request.params?.cwd).toBeUndefined();
    expect(sessionNewRequest?.request.params?.cwd).toBe("/srv/openclaw");
    expect(handle.cwd).toBe("/srv/openclaw");
    expect(decoded?.cwd).toBe("/srv/openclaw");
  });

  it("omits cwd on the wire and uses the remote fallback when no cwd is configured", async () => {
    const { runtime, gateway } = await createRuntime();

    const first = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:remote-fallback",
      agent: "codex",
      mode: "persistent",
    });
    const second = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:remote-fallback",
      agent: "codex",
      mode: "persistent",
    });
    const sessionRequests = gateway.requests.filter((entry) =>
      ["session/new", "session/load"].includes(String(entry.request.method)),
    );

    expect(sessionRequests.every((entry) => entry.request.params?.cwd === undefined)).toBe(true);
    expect(first.cwd).toBe(gateway.fallbackCwd);
    expect(second.cwd).toBe(gateway.fallbackCwd);
    expect(decodeAcpRemoteHandleState(second.runtimeSessionName)?.cwd).toBe(gateway.fallbackCwd);
  });

  it("preserves an existing remote cwd on load when callers omit cwd", async () => {
    const gateway = new MockAcpRemoteGateway();
    gateway.sessions.set("agent:codex:acp:preserve-cwd", {
      cwd: "/srv/existing-session",
      currentModeId: undefined,
      configOptions: {},
      history: [],
    });
    const { runtime } = await createRuntime({
      gateway,
      config: {
        defaultCwd: "/srv/openclaw",
      },
    });

    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:preserve-cwd",
      agent: "codex",
      mode: "persistent",
    });
    const loadRequest = gateway.requests.find((entry) => entry.request.method === "session/load");

    expect(loadRequest?.request.params?.cwd).toBeUndefined();
    expect(gateway.newCalls).toEqual([]);
    expect(handle.cwd).toBe("/srv/existing-session");
    expect(decodeAcpRemoteHandleState(handle.runtimeSessionName)?.cwd).toBe(
      "/srv/existing-session",
    );
  });

  it("reopens an existing remote session from a fresh runtime instance without replaying cwd", async () => {
    const gateway = new MockAcpRemoteGateway();
    const url = await gateway.start();
    servers.push(gateway);
    const runtimeA = new AcpRemoteRuntime({
      url,
      headers: {},
      timeoutMs: 5_000,
      retryDelayMs: 1,
      protocolVersion: ACP_REMOTE_PROTOCOL_VERSION,
    });

    const first = await runtimeA.ensureSession({
      sessionKey: "agent:codex:acp:fresh-runtime-reopen",
      agent: "codex",
      mode: "persistent",
    });
    const requestsAfterCreate = gateway.requests.length;
    const runtimeB = new AcpRemoteRuntime({
      url,
      headers: {},
      timeoutMs: 5_000,
      retryDelayMs: 1,
      protocolVersion: ACP_REMOTE_PROTOCOL_VERSION,
    });

    const reopened = await runtimeB.ensureSession({
      sessionKey: "agent:codex:acp:fresh-runtime-reopen",
      agent: "codex",
      mode: "persistent",
    });
    const reopenRequests = gateway.requests.slice(requestsAfterCreate);
    const sessionLoadRequest = reopenRequests.find(
      (entry) => entry.request.method === "session/load",
    );
    const sessionNewRequest = reopenRequests.find(
      (entry) => entry.request.method === "session/new",
    );

    expect(first.cwd).toBe(gateway.fallbackCwd);
    expect(sessionLoadRequest?.request.params?.cwd).toBeUndefined();
    expect(sessionNewRequest).toBeUndefined();
    expect(reopened.cwd).toBe(gateway.fallbackCwd);
    expect(decodeAcpRemoteHandleState(reopened.runtimeSessionName)?.cwd).toBe(gateway.fallbackCwd);
  });

  it("uses Streamable HTTP headers and omits private transport markers", async () => {
    const { runtime, gateway } = await createRuntime();

    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:transport",
      agent: "codex",
      mode: "persistent",
      cwd: "/home/test/workspace",
    });
    await runtime.setMode({ handle, mode: "steer" });
    await runtime.setConfigOption({ handle, key: "verbosity", value: "verbose" });
    await runtime.cancel({ handle, reason: "transport-check" });

    const initializeRequest = gateway.requests.find(
      (entry) => entry.request.method === "initialize",
    );
    const promptOrControlRequests = gateway.requests.filter((entry) =>
      [
        "session/new",
        "session/load",
        "session/set_mode",
        "session/set_config_option",
        "session/cancel",
      ].includes(String(entry.request.method)),
    );

    expect(initializeRequest?.headers.accept).toContain("application/json");
    expect(initializeRequest?.headers.accept).toContain("text/event-stream");
    expect(initializeRequest?.headers["content-type"]).toContain("application/json");
    expect(initializeRequest?.request.params?._meta).toBeUndefined();

    for (const entry of promptOrControlRequests) {
      const meta = (entry.request.params?._meta as Record<string, unknown> | undefined) ?? {};
      expect(meta.openclawDraftRevision).toBeUndefined();
      expect(meta.openclawTransport).toBeUndefined();
    }
  });

  it("retries dropped prompt streams and suppresses replay duplicates", async () => {
    const gateway = new MockAcpRemoteGateway();
    gateway.dropFirstPromptAttempt = true;
    const { runtime } = await createRuntime({ gateway });

    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:retry",
      agent: "codex",
      mode: "persistent",
      cwd: "/home/test/workspace",
    });

    const events = [];
    for await (const event of runtime.runTurn({
      handle,
      text: "retry-me",
      mode: "prompt",
      requestId: "req-retry",
    })) {
      events.push(event);
    }

    expect(gateway.promptAttempts.get("req-retry")).toBe(2);
    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      {
        type: "text_delta",
        text: "thinking",
        stream: "thought",
        tag: "agent_thought_chunk",
      },
      {
        type: "text_delta",
        text: "echo:retry-me",
        stream: "output",
        tag: "agent_message_chunk",
      },
    ]);
    expect(events.filter((event) => event.type === "tool_call")).toEqual([
      {
        type: "tool_call",
        text: "inspect (in_progress)",
        tag: "tool_call",
        toolCallId: "tool-1",
        status: "in_progress",
        title: "inspect",
      },
    ]);
    expect(events.at(-1)).toEqual({
      type: "done",
      stopReason: "end_turn",
    });
  });

  it("fails probe when the remote endpoint does not advertise session/load support", async () => {
    const gateway = new MockAcpRemoteGateway();
    gateway.loadSession = false;
    const { runtime } = await createRuntime({ gateway });

    await runtime.probeAvailability();

    expect(runtime.isHealthy()).toBe(false);
    await expect(runtime.doctor()).resolves.toEqual(
      expect.objectContaining({
        ok: false,
      }),
    );
  });
});
