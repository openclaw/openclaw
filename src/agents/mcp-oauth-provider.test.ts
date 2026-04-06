import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpOAuthPersistedState } from "./mcp-oauth-provider.js";

const openUrlMock = vi.hoisted(() => vi.fn(async () => true));
const homedirMock = vi.hoisted(() => vi.fn());
const serverState = vi.hoisted(() => ({
  handler: undefined as
    | ((req: { url?: string }, res: MockResponse) => void | Promise<void>)
    | undefined,
  errorHandler: undefined as ((error: Error) => void) | undefined,
  listenHost: undefined as string | undefined,
  listenPort: undefined as number | undefined,
  closed: false,
}));

type MockResponse = {
  body: string;
  headers: Record<string, string>;
  statusCode: number;
  setHeader: (key: string, value: string) => void;
  end: (body?: string) => void;
};

vi.mock("../infra/browser-open.js", () => ({
  openUrl: openUrlMock,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: homedirMock,
  };
});

vi.mock("node:http", () => ({
  createServer: vi.fn((handler) => {
    serverState.handler = handler;
    serverState.closed = false;
    return {
      on(event: string, callback: (error: Error) => void) {
        if (event === "error") {
          serverState.errorHandler = callback;
        }
      },
      close() {
        serverState.closed = true;
      },
      listen(port: number, host: string, callback?: () => void) {
        serverState.listenPort = port;
        serverState.listenHost = host;
        callback?.();
      },
    };
  }),
}));

function createResponse(): MockResponse {
  return {
    body: "",
    headers: {},
    statusCode: 200,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(body = "") {
      this.body = body;
    },
  };
}

describe("mcp-oauth-provider", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mcp-oauth-"));
    homedirMock.mockReturnValue(tempHome);
    openUrlMock.mockReset();
    openUrlMock.mockResolvedValue(true);
    serverState.handler = undefined;
    serverState.errorHandler = undefined;
    serverState.listenHost = undefined;
    serverState.listenPort = undefined;
    serverState.closed = false;
  });

  afterEach(async () => {
    vi.resetModules();
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("stores colliding-looking server names in distinct files", async () => {
    const { saveMcpOAuthState, loadMcpOAuthState } = await import("./mcp-oauth-provider.js");

    saveMcpOAuthState("my-server", {
      codeVerifier: "first",
    });
    saveMcpOAuthState("my server", {
      codeVerifier: "second",
    });

    expect(loadMcpOAuthState("my-server")?.codeVerifier).toBe("first");
    expect(loadMcpOAuthState("my server")?.codeVerifier).toBe("second");
  });

  it("persists a csrf state token when the SDK starts authorization", async () => {
    const { createMcpOAuthProvider } = await import("./mcp-oauth-provider.js");

    let persistedState: McpOAuthPersistedState | undefined;

    const provider = createMcpOAuthProvider({
      serverName: "remote",
      loadState: () => persistedState,
      saveState: (state) => {
        persistedState = structuredClone(state);
      },
    });

    const csrfState = await provider.state?.();

    expect(csrfState).toBeTypeOf("string");
    expect(await provider.getExpectedState()).toBe(csrfState);
    expect(persistedState?.csrfState).toBe(csrfState);
  });

  it("does not start the callback listener until authorization begins", async () => {
    const { createMcpOAuthProvider } = await import("./mcp-oauth-provider.js");

    const provider = createMcpOAuthProvider({
      serverName: "remote",
      loadState: () => ({ csrfState: "expected-state" }),
      saveState: () => undefined,
    });

    expect(serverState.listenPort).toBeUndefined();

    await provider.redirectToAuthorization(new URL("https://example.com/oauth/start"));

    expect(serverState.listenHost).toBe("127.0.0.1");
    expect(serverState.listenPort).toBe(8093);
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com/oauth/start");
  });

  it("rejects callback requests with the wrong csrf state", async () => {
    const { waitForOAuthCallback } = await import("./mcp-oauth-provider.js");

    const callbackPromise = waitForOAuthCallback({
      serverName: "remote",
      timeoutMs: 5_000,
      getExpectedState: () => "expected-state",
    });

    const res = createResponse();
    await serverState.handler?.({ url: "/mcp/callback?code=test-code&state=wrong-state" }, res);

    expect(serverState.listenHost).toBe("127.0.0.1");
    expect(serverState.listenPort).toBe(8093);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("state mismatch");
    await expect(callbackPromise).rejects.toThrow(/state validation/i);
    expect(serverState.closed).toBe(true);
  });

  it("accepts callback requests with the expected csrf state", async () => {
    const { waitForOAuthCallback } = await import("./mcp-oauth-provider.js");

    const callbackPromise = waitForOAuthCallback({
      serverName: "remote",
      timeoutMs: 5_000,
      getExpectedState: () => "expected-state",
    });

    const res = createResponse();
    await serverState.handler?.({ url: "/mcp/callback?code=test-code&state=expected-state" }, res);

    expect(res.statusCode).toBe(200);
    await expect(callbackPromise).resolves.toBe("test-code");
    expect(serverState.closed).toBe(true);
  });
});
