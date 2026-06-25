// Signal tests cover real send-path approval reaction behavior.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signalApprovalCapability } from "./approval-native.js";
import {
  clearSignalApprovalReactionTargetsForTest,
  maybeResolveSignalApprovalReaction,
} from "./approval-reactions.js";
import { sendMessageSignal } from "./send.js";

const resolverMocks = vi.hoisted(() => ({
  resolveSignalApproval: vi.fn(),
  isApprovalNotFoundError: vi.fn(() => false),
}));

vi.mock("./approval-resolver.js", () => ({
  resolveSignalApproval: resolverMocks.resolveSignalApproval,
  isApprovalNotFoundError: resolverMocks.isApprovalNotFoundError,
}));

type RpcCall = {
  method?: string;
  params?: Record<string, unknown>;
};

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function withSignalRpcServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error: unknown) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected local Signal RPC server to bind a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

function buildCfg(baseUrl: string) {
  return {
    channels: {
      signal: {
        apiMode: "native" as const,
        accounts: {
          default: {
            httpUrl: baseUrl,
            account: "+15550001111",
            allowFrom: ["+15551230000"],
          },
        },
      },
    },
    approvals: {
      exec: {
        enabled: true,
        mode: "targets" as const,
        targets: [{ channel: "signal", to: "+15551230000" }],
      },
      plugin: {
        enabled: true,
        mode: "targets" as const,
        targets: [{ channel: "signal", to: "+15551230000" }],
      },
    },
  };
}

describe("sendMessageSignal approval reaction behavior", () => {
  let closeServer: (() => Promise<void>) | undefined;

  beforeEach(() => {
    clearSignalApprovalReactionTargetsForTest();
    resolverMocks.resolveSignalApproval.mockReset().mockResolvedValue(undefined);
    resolverMocks.isApprovalNotFoundError.mockReset().mockReturnValue(false);
  });

  afterEach(async () => {
    await closeServer?.();
    closeServer = undefined;
  });

  it("sends ordinary approval-command snippets without reaction hints or registered targets", async () => {
    const calls: RpcCall[] = [];
    const server = await withSignalRpcServer(async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/api/v1/rpc");
      const body = JSON.parse(await readRequestBody(req)) as RpcCall & { id?: unknown };
      calls.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ jsonrpc: "2.0", result: { timestamp: 1700000001010 }, id: body.id }),
      );
    });
    closeServer = server.close;
    const cfg = buildCfg(server.baseUrl);
    const text =
      "Use this command later:\nID: plugin:abc\n\nReply with: /approve plugin:abc allow-once|deny";

    await sendMessageSignal("+15551230000", text, { cfg });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("send");
    expect(calls[0]?.params?.message).toBe(text);
    expect(String(calls[0]?.params?.message)).not.toContain("React with:");

    await expect(
      maybeResolveSignalApprovalReaction({
        cfg,
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000001010",
        reactionKey: "\u{1F44D}",
        actorId: "+15551230000",
        targetAuthor: "+15550001111",
      }),
    ).resolves.toBe(false);
    expect(resolverMocks.resolveSignalApproval).not.toHaveBeenCalled();
  });

  it("sends approval-owned prompts with reaction hints and resolves authorized reactions", async () => {
    const calls: RpcCall[] = [];
    const server = await withSignalRpcServer(async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/api/v1/rpc");
      const body = JSON.parse(await readRequestBody(req)) as RpcCall & { id?: unknown };
      calls.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ jsonrpc: "2.0", result: { timestamp: 1700000001011 }, id: body.id }),
      );
    });
    closeServer = server.close;
    const cfg = buildCfg(server.baseUrl);
    const text =
      "Plugin approval required\nID: plugin:abc\n\nReply with: /approve plugin:abc allow-once|deny";

    await sendMessageSignal("+15551230000", text, {
      cfg,
      approvalReactionBinding: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("send");
    expect(calls[0]?.params?.message).toContain("ID: plugin:abc");
    expect(calls[0]?.params?.message).toContain("React with:");

    await expect(
      maybeResolveSignalApprovalReaction({
        cfg,
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000001011",
        reactionKey: "\u{1F44D}",
        actorId: "+15551230000",
        targetAuthor: "+15550001111",
      }),
    ).resolves.toBe(true);
    expect(resolverMocks.resolveSignalApproval).toHaveBeenCalledWith({
      cfg,
      approvalId: "plugin:abc",
      decision: "allow-once",
      senderId: "+15551230000",
      gatewayUrl: undefined,
    });
  });

  it("preserves rendered target-mode exec approval reactions through send and reaction resolution", async () => {
    const calls: RpcCall[] = [];
    const server = await withSignalRpcServer(async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/api/v1/rpc");
      const body = JSON.parse(await readRequestBody(req)) as RpcCall & { id?: unknown };
      calls.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ jsonrpc: "2.0", result: { timestamp: 1700000001012 }, id: body.id }),
      );
    });
    closeServer = server.close;
    const cfg = buildCfg(server.baseUrl);
    const payload = signalApprovalCapability.render?.exec?.buildPendingPayload?.({
      cfg,
      request: {
        id: "exec-1",
        request: {
          command: "echo hi",
          agentId: "main",
          turnSourceChannel: "slack",
          turnSourceTo: "C123",
          turnSourceAccountId: "default",
          sessionKey: "agent:main:slack:C123",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      target: { channel: "signal", to: "+15551230000", source: "target" },
      nowMs: 0,
    });
    const text = payload?.text ?? "";

    expect(text).toContain("Approval required.\nID: exec-1");
    expect(text).toContain("/approve exec-1 allow-once");
    expect(text).not.toContain("React with:");

    await sendMessageSignal("+15551230000", text, {
      cfg,
      approvalReactionBinding: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("send");
    expect(calls[0]?.params?.message).toContain("Approval required.\nID: exec-1");
    expect(calls[0]?.params?.message).toContain("React with:");

    await expect(
      maybeResolveSignalApprovalReaction({
        cfg,
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000001012",
        reactionKey: "\u{1F44D}",
        actorId: "+15551230000",
        targetAuthor: "+15550001111",
      }),
    ).resolves.toBe(true);
    expect(resolverMocks.resolveSignalApproval).toHaveBeenCalledWith({
      cfg,
      approvalId: "exec-1",
      decision: "allow-once",
      senderId: "+15551230000",
      gatewayUrl: undefined,
    });
  });
});
