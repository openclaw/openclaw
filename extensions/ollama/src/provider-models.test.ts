// Ollama tests cover provider models plugin behavior.
import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import { jsonResponse, requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOllamaProvider,
  buildOllamaBaseUrlSsrFPolicy,
  buildOllamaModelDefinition,
  enrichOllamaCompletionModels,
  enrichOllamaModelsWithContext,
  fetchLoadedOllamaModelNames,
  fetchOllamaModels,
  queryOllamaModelShowInfo,
  type OllamaTagModel,
} from "./provider-models.js";

describe("ollama provider models", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps incomplete cloud metadata discoverable with remote host metadata", async () => {
    const { listed, reasoning } = {
      listed: {
        name: "deepseek-r1:671b",
        remote_host: "https://ollama.example",
        capabilities: ["vision"],
      },
      reasoning: true,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        requestUrl(input).endsWith("/api/tags")
          ? jsonResponse({ models: [listed] })
          : jsonResponse({}),
      ),
    );

    await expect(buildOllamaProvider("http://127.0.0.1:11434")).resolves.toMatchObject({
      models: [
        {
          id: listed.name,
          input: ["text", "image"],
          reasoning,
          compat: { supportsTools: true },
        },
      ],
    });
  });

  it("keeps strict node discovery closed when remote completion is only inferred", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({})),
    );

    await expect(
      enrichOllamaCompletionModels(
        "http://127.0.0.1:11434",
        [
          {
            name: "remote-chat:latest",
            remote_model: "upstream-chat:latest",
            capabilities: ["tools"],
          },
        ],
        { requireCompletionCapability: true },
      ),
    ).resolves.toEqual([]);
  });

  it("reads loaded models from /api/ps with remote auth", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(requestUrl(input)).toBe("https://ollama.example.com/api/ps");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-key");
      return jsonResponse({
        models: [{ name: "qwen3.5:4b" }, { model: "llama3.3:70b" }, { name: "   " }, {}],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchLoadedOllamaModelNames("https://ollama.example.com/v1", {
        apiKey: "private-key",
      }),
    ).resolves.toEqual({
      reachable: true,
      models: ["qwen3.5:4b", "llama3.3:70b"],
    });
  });

  it("scopes cached show metadata by credential", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/tags")) {
        return jsonResponse({ models: [{ name: "private-model", digest: "stable" }] });
      }
      const apiKey = new Headers(init?.headers).get("Authorization");
      return jsonResponse({
        model_info: {
          "private.context_length": apiKey === "Bearer account-a" ? 16_000 : 32_000,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await buildOllamaProvider("https://ollama.example.com", {
      apiKey: "account-a",
    });
    const second = await buildOllamaProvider("https://ollama.example.com", {
      apiKey: "account-b",
    });

    expect(first.models?.[0]?.contextWindow).toBe(16_000);
    expect(second.models?.[0]?.contextWindow).toBe(32_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("resolves known cloud context windows for bare and :cloud model refs", () => {
    // A suffixed ref must not silently drop to the generic default when live
    // inspection is unavailable; both spellings name the same cloud model.
    for (const modelId of ["kimi-k3", "kimi-k3:cloud"]) {
      expect(buildOllamaModelDefinition(modelId)).toEqual(
        expect.objectContaining({ id: modelId, contextWindow: 1_048_576 }),
      );
    }
  });

  it("uses Modelfile num_ctx when it expands the discovered context window", async () => {
    const models: OllamaTagModel[] = [{ name: "llama3-32k:latest" }];
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        model_info: { "llama.context_length": 8192 },
        parameters: 'stop "<|eot_id|>"\nnum_ctx 32768\nnum_keep 5',
        capabilities: ["completion"],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched).toEqual([
      {
        name: "llama3-32k:latest",
        contextWindow: 32768,
        capabilities: ["completion"],
      },
    ]);
  });

  it("closes real failed discovery sockets while preserving successful discovery", async () => {
    const sockets = new Set<Socket>();
    const socketClosures = new Map<string, Promise<void>>();
    let mode: "failure" | "success" = "failure";

    const server = createServer((request, response) => {
      const path = request.url;
      if (path !== "/api/tags" && path !== "/api/show") {
        response.writeHead(404);
        response.end();
        return;
      }

      if (mode === "failure") {
        socketClosures.set(
          path,
          new Promise<void>((resolve) => {
            request.socket.once("close", () => resolve());
          }),
        );
        response.writeHead(503, { "content-type": "text/plain" });
        // Leave the body open so only real client cancellation can close its socket.
        response.write("ollama unavailable");
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      if (path === "/api/tags") {
        response.end(JSON.stringify({ models: [{ name: "llama3:8b" }] }));
        return;
      }
      response.end(
        JSON.stringify({
          model_info: { "llama.context_length": 32768 },
          capabilities: ["completion", "tools"],
        }),
      );
    });

    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });

    const waitForSocketClose = async (path: string): Promise<void> => {
      const closed = socketClosures.get(path);
      if (!closed) {
        throw new Error(`No failed discovery socket was recorded for ${path}`);
      }

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              reject(new Error(`Failed discovery socket was not closed for ${path}`));
            }, 2_000);
          }),
        ]);
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
      }
    };

    const listening = once(server, "listening");
    try {
      server.listen(0, "127.0.0.1");
      await listening;

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Ollama test server did not expose a TCP address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;

      await expect(fetchOllamaModels(baseUrl)).resolves.toEqual({
        reachable: true,
        models: [],
      });
      await waitForSocketClose("/api/tags");

      await expect(queryOllamaModelShowInfo(baseUrl, "llama3:8b")).resolves.toEqual({
        showInspectionFailed: true,
      });
      await waitForSocketClose("/api/show");

      mode = "success";
      await expect(fetchOllamaModels(baseUrl)).resolves.toEqual({
        reachable: true,
        models: [{ name: "llama3:8b" }],
      });
      await expect(queryOllamaModelShowInfo(baseUrl, "llama3:8b")).resolves.toEqual({
        contextWindow: 32768,
        capabilities: ["completion", "tools"],
      });
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
    }
  });

  it("preserves remote-model-only list capabilities after a live inspection failure", async () => {
    const { listed, expected } = {
      listed: {
        name: "remote-chat:latest",
        remote_model: "upstream-chat:latest",
        digest: "sha256:remote-model-list-metadata",
        details: { context_length: 32_768 },
        capabilities: ["tools"],
      },
      expected: { contextWindow: 32_768, supportsTools: true },
    };

    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/api/tags") {
        response.end(
          JSON.stringify({
            models: [listed],
          }),
        );
        return;
      }
      if (request.url === "/api/show") {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: "show failed" }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });

    const listening = once(server, "listening");
    try {
      server.listen(0, "127.0.0.1");
      await listening;
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Ollama test server did not expose a TCP address");
      }

      const provider = await buildOllamaProvider(`http://127.0.0.1:${address.port}`);
      const model = expectDefined(provider.models?.[0], "show-failed Ollama model");

      expect(model.id).toBe(listed.name);
      expect(model.contextWindow).toBe(expected.contextWindow);
      expect(model.compat?.supportsTools).toBe(expected.supportsTools);
      expect(model.reasoning).toBe(listed.name.startsWith("deepseek-r1"));
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  });

  it("fails soft and stops reading when discovery streams exceed the JSON byte cap", async () => {
    // Larger than the shared 16 MiB readProviderJsonResponse cap so the bounded reader cancels
    // the stream mid-flight; if the cap were removed the reader would buffer the whole payload.
    const ONE_MIB = 1024 * 1024;
    const TOTAL_CHUNKS = 32; // 32 MiB advertised body, double the cap.
    const chunk = new Uint8Array(ONE_MIB);

    let bytesPulled = 0;
    let canceled = false;
    const makeOversizedJsonResponse = (): Response => {
      bytesPulled = 0;
      canceled = false;
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= TOTAL_CHUNKS) {
            controller.close();
            return;
          }
          pulled += 1;
          bytesPulled += chunk.length;
          controller.enqueue(chunk);
        },
        cancel() {
          canceled = true;
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOversizedJsonResponse()),
    );
    const tags = await fetchOllamaModels("http://127.0.0.1:11434");
    expect(tags).toEqual({ reachable: false, models: [] });
    expect(canceled).toBe(true);
    // Only the bounded prefix is pulled, never the full advertised 32 MiB stream.
    expect(bytesPulled).toBeLessThan(TOTAL_CHUNKS * ONE_MIB);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOversizedJsonResponse()),
    );
    const showInfo = await queryOllamaModelShowInfo("http://127.0.0.1:11434", "evil-model:latest");
    expect(showInfo).toEqual({ showInspectionFailed: true });
    expect(canceled).toBe(true);
    expect(bytesPulled).toBeLessThan(TOTAL_CHUNKS * ONE_MIB);
  });
});

describe("Ollama model discovery failures", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([503, "offline", "invalid-json", "missing-models"])(
    "preserves advisory discovery while strict catalogs reject %s",
    async (failure) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (failure === "offline") {
            throw new Error("Ollama endpoint unavailable");
          }
          return new Response(failure === "invalid-json" ? "{" : "{}", {
            status: typeof failure === "number" ? failure : 200,
          });
        }),
      );

      await expect(
        buildOllamaProvider("http://127.0.0.1:11434", { quiet: true }),
      ).resolves.toMatchObject({ models: [] });
      await expect(
        buildOllamaProvider("http://127.0.0.1:11434", { discoveryMode: "strict" }),
      ).rejects.toThrow();
    },
  );
});

describe("buildOllamaBaseUrlSsrFPolicy", () => {
  it("pins requests to the configured Ollama hostname for HTTP(S) URLs", () => {
    expect(buildOllamaBaseUrlSsrFPolicy("http://127.0.0.1:11434")).toEqual({
      hostnameAllowlist: ["127.0.0.1"],
      allowPrivateNetwork: true,
    });
    expect(buildOllamaBaseUrlSsrFPolicy("http://192.168.1.10:11434")).toEqual({
      hostnameAllowlist: ["192.168.1.10"],
      allowPrivateNetwork: true,
    });
    expect(buildOllamaBaseUrlSsrFPolicy("https://ollama.example.com/v1")).toEqual({
      hostnameAllowlist: ["ollama.example.com"],
      allowPrivateNetwork: true,
    });
  });

  it("returns no allowlist for empty or invalid base URLs", () => {
    expect(buildOllamaBaseUrlSsrFPolicy("")).toBeUndefined();
    expect(buildOllamaBaseUrlSsrFPolicy("ftp://ollama.example.com")).toBeUndefined();
    expect(buildOllamaBaseUrlSsrFPolicy("not-a-url")).toBeUndefined();
    expect(buildOllamaBaseUrlSsrFPolicy("http://metadata.google.internal")).toBeUndefined();
  });
});
