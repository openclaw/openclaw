// Qa Channel tests cover bus client plugin behavior.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  buildQaTarget,
  getQaBusState,
  parseQaTarget,
  pollQaBus,
  QA_BUS_STATE_TIMEOUT_MS,
} from "./bus-client.js";

const OVERSIZED_RESPONSE_BYTES = 18 * 1024 * 1024;

async function startJsonServer(
  handler: (req: { url?: string | undefined }) => { statusCode?: number; body: string },
) {
  const server = createServer((req, res) => {
    const response = handler({ url: req.url });
    res.writeHead(response.statusCode ?? 200, {
      "content-type": "application/json; charset=utf-8",
    });
    res.end(response.body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server failed to bind");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function listenLoopbackServer(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server failed to bind");
  }
  return address.port;
}

function createOversizedJsonServer(pathname: string): { server: Server; closed: Promise<number> } {
  let resolveClosed: (sentBytes: number) => void = () => {};
  const closed = new Promise<number>((resolve) => {
    resolveClosed = resolve;
  });
  const server = createServer((req, res) => {
    if (req.url !== pathname) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: `unexpected path: ${req.url}` }));
      return;
    }
    let sentBytes = 0;
    let stopped = false;
    let prefixSent = false;
    const prefixChunk = Buffer.from('{"payload":"');
    const bodyChunk = Buffer.alloc(64 * 1024, 0x61);
    const suffixChunk = Buffer.from('"}');
    const writeBuffer = (buffer: Buffer) => {
      sentBytes += buffer.length;
      if (!res.write(buffer)) {
        res.once("drain", writeChunks);
        return false;
      }
      return true;
    };
    const writeChunks = () => {
      if (!prefixSent) {
        prefixSent = true;
        if (!writeBuffer(prefixChunk)) {
          return;
        }
      }
      while (true) {
        if (stopped) {
          return;
        }
        if (sentBytes + bodyChunk.length + suffixChunk.length >= OVERSIZED_RESPONSE_BYTES) {
          break;
        }
        if (!writeBuffer(bodyChunk)) {
          return;
        }
      }
      if (!stopped) {
        sentBytes += suffixChunk.length;
        res.end(suffixChunk);
      }
    };
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", connection: "close" });
    res.on("close", () => {
      stopped = true;
      resolveClosed(sentBytes);
    });
    req.on("aborted", () => {
      stopped = true;
      res.destroy();
    });
    writeChunks();
  });
  return { server, closed };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

describe("qa-bus client", () => {
  const stops: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()));
  });

  it("roundtrips explicit group targets", () => {
    expect(parseQaTarget("group:ops-room")).toEqual({
      chatType: "group",
      conversationId: "ops-room",
    });
    expect(
      buildQaTarget({
        chatType: "group",
        conversationId: "ops-room",
      }),
    ).toBe("group:ops-room");
  });

  it("rejects malformed JSON responses instead of throwing from the stream callback", async () => {
    const server = await startJsonServer(() => ({
      body: '{"cursor":1,"events":[',
    }));
    stops.push(server["stop"]);

    await expect(
      pollQaBus({
        baseUrl: server.baseUrl,
        accountId: "acct-a",
        cursor: 0,
        timeoutMs: 0,
      }),
    ).rejects.toThrow("qa-bus /v1/poll: malformed JSON response");
  });

  it("bounds oversized poll responses and closes the stream early", async () => {
    const oversized = createOversizedJsonServer("/v1/poll");
    const port = await listenLoopbackServer(oversized.server);
    stops.push(async () => {
      oversized.server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        oversized.server.close((error) => (error ? reject(error) : resolve()));
      });
    });

    await expect(
      pollQaBus({
        baseUrl: `http://127.0.0.1:${port}`,
        accountId: "acct-a",
        cursor: 0,
        timeoutMs: 0,
      }),
    ).rejects.toThrow("qa-bus /v1/poll: JSON response exceeds 16777216 bytes");
    const sentBytes = await oversized.closed;
    expect(sentBytes).toBeLessThan(OVERSIZED_RESPONSE_BYTES);
  });

  it("rejects immediately when a poll request is aborted", async () => {
    const server = createServer((_req, _res) => {
      // Keep the request open so the client abort path owns the outcome.
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server failed to bind");
    }

    stops.push(async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    });

    const abort = new AbortController();
    const request = pollQaBus({
      baseUrl: `http://127.0.0.1:${address.port}`,
      accountId: "acct-a",
      cursor: 0,
      timeoutMs: 30_000,
      signal: abort.signal,
    });
    abort.abort();

    try {
      await withTimeout(request, 500, "poll abort did not settle");
      throw new Error("expected poll abort to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("AbortError");
    }
  });

  it("preserves baseUrl path prefixes when composing bus URLs", async () => {
    const server = await startJsonServer((req) => ({
      statusCode: req.url === "/qa-bus/v1/state" ? 200 : 404,
      body:
        req.url === "/qa-bus/v1/state"
          ? JSON.stringify({
              cursor: 1,
              conversations: [],
              threads: [],
              messages: [],
              events: [],
            })
          : JSON.stringify({ error: `unexpected path: ${req.url}` }),
    }));
    stops.push(server["stop"]);

    await expect(getQaBusState(`${server.baseUrl}/qa-bus`)).resolves.toEqual({
      cursor: 1,
      conversations: [],
      threads: [],
      messages: [],
      events: [],
    });
  });

  it("bounds oversized qa-bus state responses", async () => {
    const oversized = createOversizedJsonServer("/v1/state");
    const port = await listenLoopbackServer(oversized.server);
    stops.push(async () => {
      oversized.server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        oversized.server.close((error) => (error ? reject(error) : resolve()));
      });
    });

    await expect(getQaBusState(`http://127.0.0.1:${port}`)).rejects.toThrow(
      "qa-channel.bus-state: JSON response exceeds 16777216 bytes",
    );
  });

  it("negative control: never-headers peer stays pending without timeoutMs", async () => {
    // Pre-fix shape: fetchWithSsrFGuard with no timeoutMs / AbortSignal against
    // a peer that accepts TCP but never returns headers stays pending forever.
    const server = createServer((_req, _res) => {});
    const port = await listenLoopbackServer(server);
    stops.push(async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    });

    const hung = fetchWithSsrFGuard({
      url: `http://127.0.0.1:${port}/v1/state`,
      policy: { allowPrivateNetwork: true },
      auditContext: "qa-channel.bus-state.negative-control",
    });
    const outcome = await Promise.race([
      hung.then(() => "resolved" as const),
      new Promise<"still-pending">((resolve) => {
        setTimeout(() => resolve("still-pending"), 200);
      }),
    ]);
    expect(outcome).toBe("still-pending");
    console.log(
      `[qa-channel bus-state negative control] outcome=${outcome} wait_ms=200 without_timeoutMs=true`,
    );
    // Tear down the hung peer so the orphaned fetch cannot outlive the suite.
    server.closeAllConnections?.();
  });

  it("times out state fetches when the peer never returns headers", async () => {
    expect(QA_BUS_STATE_TIMEOUT_MS).toBe(10_000);
    // Accept TCP but never write headers — body idle caps never start.
    const server = createServer((_req, _res) => {});
    const port = await listenLoopbackServer(server);
    stops.push(async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    });

    const startedAt = Date.now();
    const outcome = await getQaBusState(`http://127.0.0.1:${port}`, { timeoutMs: 80 }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const elapsedMs = Date.now() - startedAt;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatchObject({
        name: "TimeoutError",
      });
    }
    expect(elapsedMs).toBeGreaterThanOrEqual(60);
    expect(elapsedMs).toBeLessThan(2_000);
    console.log(
      `[qa-channel bus-state hang proof] timed_out=${!outcome.ok} name=${
        outcome.ok
          ? "n/a"
          : outcome.error instanceof Error
            ? outcome.error.name
            : typeof outcome.error
      } elapsed_ms=${elapsedMs} production_timeout_ms=${QA_BUS_STATE_TIMEOUT_MS}`,
    );
  });
});
