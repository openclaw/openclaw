import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { runAcpRuntimeAdapterContract } from "../../../src/acp/runtime/adapter-contract.testkit.js";
import { ACP_REMOTE_DRAFT_REVISION } from "./config.js";
import { AcpRemoteRuntime, decodeAcpRemoteHandleState } from "./runtime.js";

type RpcRequest = {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

class MockAcpRemoteGateway {
  private readonly server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const requestLine = Buffer.concat(chunks).toString("utf8").trim().split("\n")[0] ?? "";
    const request = JSON.parse(requestLine || "{}") as RpcRequest;

    const send = (message: unknown) => {
      res.write(`${JSON.stringify(message)}\n`);
    };

    const ok = () => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
    };

    if (request.method === "initialize") {
      ok();
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: request.params?.protocolVersion ?? 1,
          agentCapabilities: {
            loadSession: true,
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
          _meta: {
            openclawDraftRevision: this.draftRevision,
          },
        },
      });
      res.end();
      return;
    }

    if (request.method === "session/load") {
      ok();
      const sessionId = String(request.params?.sessionId ?? "");
      this.loadCalls.push(sessionId);
      if (!this.sessions.has(sessionId)) {
        send({
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
        res.end();
        return;
      }
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          modes: this.sessions.get(sessionId)?.currentModeId
            ? {
                currentModeId: this.sessions.get(sessionId)?.currentModeId,
                availableModes: [{ id: "contract", name: "Contract" }],
              }
            : undefined,
          configOptions: Object.entries(this.sessions.get(sessionId)?.configOptions ?? {}).map(
            ([id, currentValue]) => ({
              type: "select",
              id,
              name: id,
              currentValue,
              options: [],
            }),
          ),
        },
      });
      res.end();
      return;
    }

    if (request.method === "session/new") {
      ok();
      const sessionId = String(request.params?._meta?.openclawSessionId ?? "");
      this.newCalls.push(sessionId);
      this.sessions.set(sessionId, {
        currentModeId: undefined,
        configOptions: {},
      });
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          sessionId,
        },
      });
      res.end();
      return;
    }

    if (request.method === "session/set_mode") {
      ok();
      const sessionId = String(request.params?.sessionId ?? "");
      const modeId = String(request.params?.modeId ?? "");
      this.setModeCalls.push({ sessionId, modeId });
      const session = this.sessions.get(sessionId);
      if (session) {
        session.currentModeId = modeId;
      }
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {},
      });
      res.end();
      return;
    }

    if (request.method === "session/set_config_option") {
      ok();
      const sessionId = String(request.params?.sessionId ?? "");
      const configId = String(request.params?.configId ?? "");
      const value = String(request.params?.value ?? "");
      this.setConfigCalls.push({ sessionId, configId, value });
      const session = this.sessions.get(sessionId);
      if (session) {
        session.configOptions[configId] = value;
      }
      send({
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
      res.end();
      return;
    }

    if (request.method === "session/close") {
      ok();
      const sessionId = String(request.params?.sessionId ?? "");
      this.closeCalls.push(sessionId);
      this.sessions.delete(sessionId);
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {},
      });
      res.end();
      return;
    }

    if (request.method === "session/cancel") {
      ok();
      const sessionId = String(request.params?.sessionId ?? "");
      this.cancelCalls.push(sessionId);
      res.end();
      return;
    }

    if (request.method === "session/prompt") {
      ok();
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

      for (const notification of stored.notifications) {
        send(notification);
      }
      if (this.dropFirstPromptAttempt && attempt === 1) {
        res.end();
        return;
      }
      send(stored.terminal);
      res.end();
      return;
    }

    ok();
    send({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32_600,
        message: `unsupported method: ${String(request.method)}`,
      },
    });
    res.end();
  });

  draftRevision = ACP_REMOTE_DRAFT_REVISION;
  dropFirstPromptAttempt = false;
  readonly sessions = new Map<
    string,
    {
      currentModeId?: string;
      configOptions: Record<string, string>;
    }
  >();
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
    requiredDraftRevision?: string;
  } = {},
) {
  const gateway = params.gateway ?? new MockAcpRemoteGateway();
  const url = await gateway.start();
  servers.push(gateway);
  const runtime = new AcpRemoteRuntime({
    url,
    headers: {},
    timeoutMs: 5_000,
    retryDelayMs: 1,
    requiredDraftRevision: params.requiredDraftRevision ?? ACP_REMOTE_DRAFT_REVISION,
    protocolVersion: 1,
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

  it("reopens sessions by stable OpenClaw session key", async () => {
    const { runtime, gateway } = await createRuntime();

    const first = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:stable",
      agent: "codex",
      mode: "persistent",
      cwd: "/tmp/workspace",
    });
    const decoded = decodeAcpRemoteHandleState(first.runtimeSessionName);

    expect(first.backendSessionId).toBe("agent:codex:acp:stable");
    expect(decoded?.sessionId).toBe("agent:codex:acp:stable");
    expect(gateway.newCalls).toEqual(["agent:codex:acp:stable"]);

    await runtime.ensureSession({
      sessionKey: "agent:codex:acp:stable",
      agent: "codex",
      mode: "persistent",
      cwd: "/tmp/workspace",
    });

    expect(gateway.loadCalls).toEqual(["agent:codex:acp:stable", "agent:codex:acp:stable"]);
    expect(gateway.newCalls).toEqual(["agent:codex:acp:stable"]);
  });

  it("retries dropped prompt streams and suppresses replay duplicates", async () => {
    const gateway = new MockAcpRemoteGateway();
    gateway.dropFirstPromptAttempt = true;
    const { runtime } = await createRuntime({ gateway });

    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:retry",
      agent: "codex",
      mode: "persistent",
      cwd: "/tmp/workspace",
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

  it("fails probe when the remote draft revision is incompatible", async () => {
    const gateway = new MockAcpRemoteGateway();
    gateway.draftRevision = "wrong-draft";
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
