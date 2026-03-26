import { describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { TransportClosedError } from "./errors.js";
import type { JsonRpcMessage } from "./jsonrpc.js";
import type { AppServerTransport, TransportCloseEvent } from "./transport/process.js";

class MemoryTransport implements AppServerTransport {
  closed = false;
  readonly written: JsonRpcMessage[] = [];
  private readonly messageListeners = new Set<(message: JsonRpcMessage) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly closeListeners = new Set<(event: TransportCloseEvent) => void>();
  private readonly stderrListeners = new Set<(chunk: string) => void>();

  write(message: JsonRpcMessage): void {
    if (this.closed) {
      throw new TransportClosedError();
    }
    this.written.push(message);
  }

  async close(): Promise<TransportCloseEvent> {
    this.closed = true;
    const event = {
      code: 0,
      signal: null,
      hadError: false,
    } satisfies TransportCloseEvent;
    for (const listener of [...this.closeListeners]) {
      listener(event);
    }
    return event;
  }

  emitMessage(message: JsonRpcMessage): void {
    for (const listener of [...this.messageListeners]) {
      listener(message);
    }
  }

  emitError(error: Error): void {
    for (const listener of [...this.errorListeners]) {
      listener(error);
    }
  }

  emitStderr(chunk: string): void {
    for (const listener of [...this.stderrListeners]) {
      listener(chunk);
    }
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  onClose(listener: (event: TransportCloseEvent) => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  onStderr(listener: (chunk: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => {
      this.stderrListeners.delete(listener);
    };
  }
}

describe("CodexAppServerClient", () => {
  it("opts initializeSession into experimental APIs by default", async () => {
    const transport = new MemoryTransport();
    const client = new CodexAppServerClient({
      transport,
      requestIdFactory: () => "req-init",
    });

    const promise = client.initializeSession();

    expect(transport.written[0]).toEqual({
      id: "req-init",
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex-sdk",
          version: "0.1.0",
          title: null,
        },
        capabilities: {
          experimentalApi: true,
        },
      },
      trace: undefined,
    });

    transport.emitMessage({
      id: "req-init",
      result: {
        userAgent: "codex-app-server",
        platformFamily: "unix",
        platformOs: "macos",
      },
    });

    await expect(promise).resolves.toEqual({
      userAgent: "codex-app-server",
      platformFamily: "unix",
      platformOs: "macos",
    });
    expect(transport.written[1]).toEqual({ method: "initialized" });
  });

  it("routes loginAccount to account/login/start", async () => {
    const transport = new MemoryTransport();
    const client = new CodexAppServerClient({
      transport,
      requestIdFactory: () => "req-login",
    });

    const promise = client.loginAccount({
      type: "chatgptAuthTokens",
      accessToken: "access-token",
      chatgptAccountId: "acct-123",
      chatgptPlanType: "plus",
    });

    expect(transport.written[0]).toEqual({
      id: "req-login",
      method: "account/login/start",
      params: {
        type: "chatgptAuthTokens",
        accessToken: "access-token",
        chatgptAccountId: "acct-123",
        chatgptPlanType: "plus",
      },
      trace: undefined,
    });

    transport.emitMessage({
      id: "req-login",
      result: { type: "chatgptAuthTokens" },
    });

    await expect(promise).resolves.toEqual({ type: "chatgptAuthTokens" });
  });

  it("routes listMcpServerStatus to mcpServerStatus/list", async () => {
    const transport = new MemoryTransport();
    const client = new CodexAppServerClient({
      transport,
      requestIdFactory: () => "req-status",
    });

    const promise = client.listMcpServerStatus({
      cursor: "next",
      limit: 25,
    });

    expect(transport.written[0]).toEqual({
      id: "req-status",
      method: "mcpServerStatus/list",
      params: {
        cursor: "next",
        limit: 25,
      },
      trace: undefined,
    });

    transport.emitMessage({
      id: "req-status",
      result: {
        data: [
          {
            name: "gmail",
            tools: {},
            resources: [],
            resourceTemplates: [],
            authStatus: "oAuth",
          },
        ],
        nextCursor: null,
      },
    });

    await expect(promise).resolves.toEqual({
      data: [
        {
          name: "gmail",
          tools: {},
          resources: [],
          resourceTemplates: [],
          authStatus: "oAuth",
        },
      ],
      nextCursor: null,
    });
  });

  it("handles account/chatgptAuthTokens/refresh through a typed helper", async () => {
    const transport = new MemoryTransport();
    const client = new CodexAppServerClient({ transport });

    const unsubscribe = client.handleChatgptAuthTokensRefresh(async (params) => {
      expect(params).toEqual({
        reason: "unauthorized",
        previousAccountId: "acct-previous",
      });
      return {
        accessToken: "fresh-token",
        chatgptAccountId: "acct-current",
        chatgptPlanType: "pro",
      };
    });

    transport.emitMessage({
      id: "refresh-1",
      method: "account/chatgptAuthTokens/refresh",
      params: {
        reason: "unauthorized",
        previousAccountId: "acct-previous",
      },
    });

    await vi.waitFor(() => {
      expect(transport.written[0]).toEqual({
        id: "refresh-1",
        result: {
          accessToken: "fresh-token",
          chatgptAccountId: "acct-current",
          chatgptPlanType: "pro",
        },
      });
    });

    unsubscribe();
  });
});
