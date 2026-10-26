import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type { DiagnosticsChannel } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../test-support/hanging-loopback-server.js";
import { CopilotRuntimeAuthError } from "./runtime-auth-error.js";

const resolveToken = vi.hoisted(() => vi.fn());
const authenticate = vi.hoisted(() => vi.fn());
const guardFetch = vi.hoisted(() => vi.fn());

// mock-isolation: Embedding requests use fixture credentials instead of discovering operator accounts.
vi.mock("./auth.js", () => ({
  resolveFirstGithubToken: resolveToken,
}));

// mock-isolation: Each case owns runtime credentials and the synthetic provider endpoint.
vi.mock("./runtime-auth.js", () => ({
  DEFAULT_COPILOT_API_BASE_URL: "https://example.test",
  resolveCopilotRuntimeAuth: authenticate,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: guardFetch,
}));

import { githubCopilotMemoryEmbeddingProviderAdapter as adapter } from "./embeddings.js";

afterAll(() => {
  vi.doUnmock("./auth.js");
  vi.doUnmock("./runtime-auth.js");
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

const TEST_BASE_URL = "https://example.test";

function mockModels(
  models: Array<{ id: string; supported_endpoints?: string[] }> = [
    { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
  ],
) {
  guardFetch.mockResolvedValueOnce({
    response: Response.json({ data: models }),
    release: vi.fn(async () => {}),
  });
}

const defaultCreateOptions = { config: {}, agentDir: "/tmp/test-agent", model: "" };

function create(options: Partial<Parameters<typeof adapter.create>[0]> = {}) {
  return adapter.create({ ...defaultCreateOptions, ...options });
}

function configured<T>(settings: T) {
  return {
    models: {
      providers: { "github-copilot": { baseUrl: TEST_BASE_URL, models: [], ...settings } },
    },
  };
}

describe("githubCopilotMemoryEmbeddingProviderAdapter", () => {
  beforeEach(() => {
    resolveToken.mockResolvedValue({
      githubToken: "test-token-placeholder",
    });
    authenticate.mockResolvedValue({
      apiKey: "test-token-placeholder",
      baseUrl: TEST_BASE_URL,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resolveToken.mockReset();
    authenticate.mockReset();
    guardFetch.mockReset();
  });

  it.each(["gpt-4o", "github-copilot/github-copilot/text-embedding-3-small"])(
    "rejects the unavailable explicit model %s",
    async (model) => {
      mockModels();

      await expect(
        create({
          model:
            adapter.normalizeModel?.({
              ...defaultCreateOptions,
              model,
            }) ?? model,
        }),
      ).rejects.toThrow(`GitHub Copilot embedding model "${model}" is not available`);
    },
  );

  it("throws when discovery finds no embedding models", async () => {
    mockModels([{ id: "gpt-4o", supported_endpoints: ["/v1/chat/completions"] }]);

    await expect(create()).rejects.toThrow("No embedding models available from GitHub Copilot");
  });

  it("does not forward a stored GitHub token to a custom remote endpoint", async () => {
    await expect(
      create({
        remote: { baseUrl: "https://proxy.example/v1" },
      }),
    ).rejects.toThrow("custom baseUrl requires an explicit memory.search.remote.apiKey");

    expect(resolveToken).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
    expect(guardFetch).not.toHaveBeenCalled();
  });

  it("does not exchange auth, discover models, or embed after an unavailable owner credential", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    resolveToken.mockRejectedValue(
      new Error(
        "providers.github-copilot.authProfiles.github-copilot:github.tokenRef is unresolved",
      ),
    );

    await expect(create()).rejects.toThrow("github-copilot:github.tokenRef is unresolved");

    expect(authenticate).not.toHaveBeenCalled();
    expect(guardFetch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unresolved remote ref without falling back to another profile", async () => {
    await expect(
      create({
        remote: {
          apiKey: { source: "env", provider: "default", id: "MISSING_TEST_VALUE" },
        },
      } as never),
    ).rejects.toMatchObject({
      name: "UnresolvedSecretInputError",
      path: "memory.search.remote.apiKey",
    });
    expect(resolveToken).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("selects fallback for authentication and discovery errors, but not unrelated failures", () => {
    const cases: Array<[Error, boolean]> = [
      [new Error("Copilot user response missing endpoints.api"), true],
      [new Error("Unexpected response from GitHub Copilot user endpoint"), true],
      [new Error("github-copilot.model-discovery: malformed JSON response"), true],
      [new CopilotRuntimeAuthError({ reason: "timeout", timeoutMs: 30_000 }), true],
      [new Error("Network timeout"), false],
    ];
    for (const [error, expected] of cases) {
      expect(adapter.shouldContinueAutoSelection?.(error)).toBe(expected);
    }
  });
});

type CopilotServer = {
  baseUrl: string;
  requests: Array<{ method: string | undefined; url: string | undefined }>;
};

const servers: Array<{ close: () => Promise<void> }> = [];

const DISCOVERY_MODELS_BODY = JSON.stringify({
  data: [{ id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] }],
});

async function startCopilotServer(handle: {
  models: string | ((response: ServerResponse) => void);
  embeddings?: string | ((response: ServerResponse) => void);
  observeRequest?: (request: IncomingMessage, body: string) => void;
}): Promise<CopilotServer> {
  const requests: CopilotServer["requests"] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      // Drain the request body so keep-alive sockets close cleanly.
      const body = await new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      handle.observeRequest?.(req, body);
      requests.push({ method: req.method, url: req.url });
      const isEmbeddings =
        req.method === "POST" && ["/embeddings", "/v1/embeddings"].includes(req.url ?? "");
      const route = isEmbeddings && handle.embeddings ? handle.embeddings : handle.models;
      if (typeof route === "function") {
        route(res);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(route);
    })();
  });

  const port = await listenOnLoopback(server);

  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  });

  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function pointTokenAt(baseUrl: string): void {
  authenticate.mockResolvedValue({
    apiKey: "copilot_test_token_abc",
    baseUrl,
  });
}

function createRemote(
  remote?: Parameters<typeof adapter.create>[0]["remote"],
  config: Parameters<typeof adapter.create>[0]["config"] = {},
  model = "",
) {
  return create({ config, remote, model });
}

// Points the global logging-config reader at an on-disk config with sensitive
// redaction turned off, so the test proves the error paths force masking rather
// than inheriting the operator's `logging.redactSensitive` preference.
function withRedactionDisabledConfig(): () => void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-redact-off-"));
  const configPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({ logging: { redactSensitive: "off" } }));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  return () => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

describe("adapter real transport", () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
      "openclaw/plugin-sdk/ssrf-runtime",
    );
    guardFetch.mockImplementation(actual.fetchWithSsrFGuard);
    resolveToken.mockResolvedValue({
      githubToken: "gh_test_token_123",
      githubDomain: "acme.ghe.com",
    });
  });

  afterEach(async () => {
    const pending = servers.splice(0);
    await Promise.all(pending.map((server) => server.close()));
    resolveToken.mockReset();
    authenticate.mockReset();
    guardFetch.mockReset();
  });

  it.each(["headers", "trickling body"])(
    "aborts model discovery with stalled %s within its operation deadline",
    async (phase) => {
      let bodyReceived = false;
      let connectionClosed = false;
      const server = await startCopilotServer({
        models: (response) => {
          const trickle =
            phase === "trickling body" ? setInterval(() => response.write(" "), 100) : undefined;
          // Finish successfully beyond the deadline so a missing timeout fails
          // the assertion without leaving a hanging request in the test process.
          const finish = setTimeout(() => response.end(DISCOVERY_MODELS_BODY), 15_000);
          response.on("close", () => {
            connectionClosed = true;
            clearInterval(trickle);
            clearTimeout(finish);
          });
        },
      });
      const bodyChannel = channel("undici:request:bodyChunkReceived");
      const onBody = (message: unknown) => {
        const { request } = message as DiagnosticsChannel.RequestBodyChunkReceivedMessage;
        if (String(request.origin) === server.baseUrl && request.path === "/models") {
          bodyReceived = true;
        }
      };
      bodyChannel.subscribe(onBody);
      const realSetTimeout = globalThis.setTimeout;
      // Scale long deadlines together, leaving Undici's retained sub-second
      // timer pump and the real body trickle untouched across later requests.
      const timeoutSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((callback, delay, ...args) =>
          realSetTimeout(
            callback,
            delay !== undefined && delay >= 1_000 ? Math.ceil(delay / 10) : delay,
            ...args,
          ),
        );
      const startedAt = performance.now();

      try {
        await expect(
          createRemote({ baseUrl: server.baseUrl, apiKey: "copilot-test-only" }),
        ).rejects.toThrow("request timed out");

        expect(performance.now() - startedAt).toBeLessThan(1_500);
        expect(bodyReceived).toBe(phase === "trickling body");
        await vi.waitFor(() => expect(connectionClosed).toBe(true));
        expect(server.requests).toEqual([{ method: "GET", url: "/models" }]);
      } finally {
        bodyChannel.unsubscribe(onBody);
        timeoutSpy.mockRestore();
      }
    },
    20_000,
  );

  it.each([
    ["model discovery", 401, false],
    ["embeddings", 429, false],
    ["model discovery", 403, true],
  ] as const)(
    "redacts %s HTTP %s errors (logging disabled: %s)",
    async (stage, status, disabled) => {
      const marker = "UNIQUESECRET";
      const token = `${stage === "embeddings" ? "gho" : "ghu"}_AAAA${marker}XXXX111122223333`;
      const message = "upstream denied";
      const restoreConfig = disabled ? withRedactionDisabledConfig() : () => {};
      try {
        let closed = false;
        const failure = (response: ServerResponse) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.write(
            JSON.stringify({
              error: { message },
              access_token: token,
              reflected: "synthetic%2Bcredential%3Avalue",
              padding: "x".repeat(8192),
              tail: "tail",
            }),
          );
          response.on("close", () => {
            closed = true;
          });
        };
        const server = await startCopilotServer({
          models: stage === "embeddings" ? DISCOVERY_MODELS_BODY : failure,
          embeddings: failure,
        });
        pointTokenAt(server.baseUrl);
        const request = async () => {
          const result = await createRemote({
            headers: { "X-Proxy-Token": "synthetic+credential:value" },
          });
          await result.provider?.embed("hello", { inputType: "query" });
        };
        const caught = await request().catch((error: unknown) => error);
        if (!(caught instanceof Error)) {
          throw new Error("Expected provider error");
        }
        expect(caught.message).toContain(`GitHub Copilot ${stage} HTTP ${status}`);
        expect(caught.message).toContain(message);
        expect(caught.message).not.toContain(token);
        expect(caught.message).not.toContain(marker);
        expect(caught.message).toContain('"reflected":"***"');
        expect(caught.message).not.toContain("tail");
        expect(caught.message.length).toBeLessThan(8_300);
        await vi.waitFor(() => expect(closed).toBe(true));
        expect(server.requests).toEqual([
          { method: "GET", url: "/models" },
          ...(stage === "embeddings" ? [{ method: "POST", url: "/embeddings" }] : []),
        ]);
      } finally {
        restoreConfig();
      }
    },
  );

  it.each(["profile", "custom"])(
    "preserves %s authentication and embedding wire requests",
    async (auth) => {
      const observed: Array<{ headers: IncomingMessage["headers"]; body: string }> = [];
      const server = await startCopilotServer({
        models: DISCOVERY_MODELS_BODY,
        observeRequest: (request, body) => {
          observed.push({ headers: request.headers, body });
        },
        embeddings: (response) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              data:
                server.requests.length === 2
                  ? [{ index: 0, embedding: [3, 4] }]
                  : [
                      { index: 1, embedding: [0, 2] },
                      { index: 0, embedding: [3, 0] },
                    ],
            }),
          );
        },
      });
      pointTokenAt(server.baseUrl);

      const prefix = auth === "custom" ? "/v1" : "";
      const model = "github-copilot/text-embedding-3-small";
      expect(adapter.normalizeModel?.({ ...defaultCreateOptions, model })).toBe(
        "text-embedding-3-small",
      );
      const result = await createRemote(
        {
          ...(auth === "custom"
            ? { baseUrl: `${server.baseUrl}${prefix}`, apiKey: "explicit-test-token" }
            : {}),
          headers: {
            Authorization: "replaced-test-token",
            "X-Proof": "forwarded",
            ...(auth === "profile" ? { "COPILOT-INTEGRATION-ID": "remote-identity" } : {}),
          },
        },
        configured({
          baseUrl: server.baseUrl,
          params: { githubDomain: "other.ghe.com" },
          headers:
            auth === "profile"
              ? {
                  "copilot-integration-id": "vscode-chat",
                  "X-Private-Header": "not-for-embeddings",
                }
              : undefined,
        }),
        auth === "profile" ? model : "",
      );
      expect(result.provider?.model).toBe("text-embedding-3-small");
      if (auth === "profile") {
        expect(authenticate).toHaveBeenCalledWith(
          expect.objectContaining({
            githubToken: "gh_test_token_123",
            githubDomain: "acme.ghe.com",
          }),
        );
      }
      expect(await result.provider?.embed("hello", { inputType: "query" })).toEqual([0.6, 0.8]);
      expect(await result.provider?.embedBatch(["first", { text: "second" }])).toEqual([
        [1, 0],
        [0, 1],
      ]);

      expect(server.requests).toEqual([
        { method: "GET", url: `${prefix}/models` },
        { method: "POST", url: `${prefix}/embeddings` },
        { method: "POST", url: `${prefix}/embeddings` },
      ]);
      const authorization = `Bearer ${auth === "custom" ? "explicit-test-token" : "copilot_test_token_abc"}`;
      expect(observed[0]?.headers["accept-encoding"]).toBe("identity");
      for (const { headers } of observed) {
        expect(headers).toMatchObject({
          authorization,
          "copilot-integration-id":
            auth === "profile" ? "remote-identity" : "copilot-developer-cli",
          "x-proof": "forwarded",
        });
        expect(headers).not.toHaveProperty("x-private-header");
      }
      expect(observed.map(({ body }) => body)).toEqual([
        "",
        JSON.stringify({ model: "text-embedding-3-small", input: ["hello"] }),
        JSON.stringify({ model: "text-embedding-3-small", input: ["first", "second"] }),
      ]);
      expect(resolveToken).toHaveBeenCalledTimes(auth === "custom" ? 0 : 1);
      expect(authenticate).toHaveBeenCalledTimes(auth === "custom" ? 0 : 1);
    },
  );
});
