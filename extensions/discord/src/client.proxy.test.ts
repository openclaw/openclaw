// Discord tests cover client.proxy plugin behavior.
import http from "node:http";
import net from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscordRestClient } from "./client.js";

const makeProxyFetchMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/fetch-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/fetch-runtime")>(
    "openclaw/plugin-sdk/fetch-runtime",
  );
  makeProxyFetchMock.mockImplementation((proxyUrl: string) => {
    if (proxyUrl === "bad-proxy") {
      throw new Error("bad proxy");
    }
    return actual.makeProxyFetch(proxyUrl);
  });
  return {
    ...actual,
    makeProxyFetch: makeProxyFetchMock,
  };
});

describe("createDiscordRestClient proxy support", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    makeProxyFetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("injects a custom fetch into RequestClient when a Discord proxy is configured", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://127.0.0.1:8080",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      customFetch?: typeof fetch;
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://127.0.0.1:8080");
    expect(requestClient.options?.fetch).toBe(makeProxyFetchMock.mock.results[0]?.value);
    expect(requestClient.customFetch).toBe(requestClient.options?.fetch);
  });

  it("accepts configured DNS proxy hosts", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://mitm-proxy:8080",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      customFetch?: typeof fetch;
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://mitm-proxy:8080");
    expect(requestClient.options?.fetch).toBe(makeProxyFetchMock.mock.results[0]?.value);
    expect(requestClient.customFetch).toBe(requestClient.options?.fetch);
  });

  it("accepts configured HTTPS proxy hosts", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "https://proxy.example:8443",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      customFetch?: typeof fetch;
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).toHaveBeenCalledWith("https://proxy.example:8443");
    expect(requestClient.options?.fetch).toBe(makeProxyFetchMock.mock.results[0]?.value);
    expect(requestClient.customFetch).toBe(requestClient.options?.fetch);
  });

  it("accepts configured proxy URLs with credentials", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://user:secret@mitm-proxy:8080",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://user:secret@mitm-proxy:8080");
    expect(requestClient.options?.fetch).toBe(makeProxyFetchMock.mock.results[0]?.value);
  });

  it("accepts arbitrary configured DNS proxy hosts", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://proxy.test:8080",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(requestClient.options?.fetch).toBe(makeProxyFetchMock.mock.results[0]?.value);
  });

  it("does not inject fetch when no proxy is configured", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      options?: { fetch?: typeof fetch };
    };

    expect(requestClient.options?.fetch).toBeUndefined();
  });

  it("falls back to direct fetch when the Discord proxy URL is invalid", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "bad-proxy",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).not.toHaveBeenCalledWith("bad-proxy");
    expect(requestClient.options?.fetch).toBeUndefined();
  });

  it("accepts configured non-loopback IP proxy URLs", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://10.0.0.10:8080",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://10.0.0.10:8080");
    expect(requestClient.options?.fetch).toBe(makeProxyFetchMock.mock.results[0]?.value);
  });

  it("accepts IPv6 loopback Discord proxy URLs", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://[::1]:8080",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://[::1]:8080");
    expect(requestClient.options?.fetch).toBe(makeProxyFetchMock.mock.results[0]?.value);
  });

  it("serializes multipart media through the configured proxy", async () => {
    let received:
      | {
          contentType: string | undefined;
          body: string;
        }
      | undefined;
    const targetServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("error", (error) => res.destroy(error));
      req.on("end", () => {
        received = {
          contentType: req.headers["content-type"],
          body: Buffer.concat(chunks).toString("utf8"),
        };
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: "message-id", channel_id: "channel-id" }));
      });
    });
    const targetPort = await listen(targetServer);
    const proxy = await startConnectProxy(targetPort);

    try {
      const cfg = {
        channels: {
          discord: {
            token: "Bot test-token",
            proxy: proxy.url,
          },
        },
      } as OpenClawConfig;
      const { rest } = createDiscordRestClient({ cfg });
      rest.options.baseUrl = `http://127.0.0.1:${targetPort}`;
      rest.options.queueRequests = false;

      await rest.post("/channels/123/messages", {
        body: {
          content: "with image",
          files: [{ data: Buffer.from("png-data"), name: "image.png" }],
        },
      });

      if (!received) {
        throw new Error("target server did not receive request");
      }

      expect(proxy.connectTargets).toEqual([`127.0.0.1:${targetPort}`]);
      expect(received.contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(received.body).toContain('name="files[0]"; filename="image.png"');
      expect(received.body).toContain('name="payload_json"');
      expect(received.body).toContain('"attachments":[{"id":0,"filename":"image.png"}]');
    } finally {
      await proxy.stop();
      await closeServer(targetServer);
    }
  });
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server address unavailable"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function startConnectProxy(targetPort: number): Promise<{
  url: string;
  connectTargets: string[];
  stop: () => Promise<void>;
}> {
  const connectTargets: string[] = [];
  const sockets = new Set<{ destroy: () => void }>();
  const server = http.createServer((_req, res) => {
    res.writeHead(502);
    res.end("CONNECT required");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (req, clientSocket, head) => {
    connectTargets.push(req.url ?? "");
    const upstreamSocket = net.connect(targetPort, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });
    sockets.add(clientSocket);
    sockets.add(upstreamSocket);
    clientSocket.on("close", () => sockets.delete(clientSocket));
    upstreamSocket.on("close", () => sockets.delete(upstreamSocket));
    clientSocket.on("error", () => upstreamSocket.destroy());
    upstreamSocket.on("error", () => clientSocket.destroy());
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    connectTargets,
    stop: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeServer(server);
    },
  };
}
