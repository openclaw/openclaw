/**
 * Fake MAX HTTP server for Phase 1B supervisor tests (per
 * docs/max-plugin/plan.md §6.1.7).
 *
 * Mimics the polling endpoint of `https://platform-api.max.ru` (`GET /updates`)
 * by replaying a queue of pre-baked HTTP responses described in a scenario JSON
 * file. Each call to `GET /updates` consumes the next response (status,
 * headers, body, optional delay, optional connection-drop).
 *
 * The supervisor (Phase 1B) and individual unit tests point their `apiRoot` at
 * `http://127.0.0.1:<port>`. Reused by the manual CLI entry at the bottom of
 * this file (`tsx server.ts <scenario.json> --port 9999`) so the plugin can be
 * exercised by hand before a real bot token arrives.
 *
 * NOTE: Phase 1B.0 only exposes the polling endpoint. POST /messages and the
 * upload surfaces are intentionally out of scope; they answer 501 to make
 * misuse loud rather than silent. Phase 1B.1 wires outbound through the same
 * harness once the supervisor lands.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export type FakeMaxResponseSpec = {
  /** HTTP status to return; defaults to 200. */
  status?: number;
  /** Extra response headers (Content-Type defaults to application/json when body is present). */
  headers?: Record<string, string>;
  /**
   * JSON body to serialize. For 200 responses, supervisor expects
   * `{ updates: Update[], marker: number }`. For non-200, the SDK reads
   * `{ code, message }` into `MaxError`.
   */
  body?: unknown;
  /** Delay (ms) before sending headers. Used by the slow-response scenario. */
  delayMs?: number;
  /**
   * Drop the TCP connection without sending a response. Models undici/Node
   * `TypeError` ("fetch failed") in the supervisor (network-drop scenario).
   */
  closeConnection?: boolean;
  /**
   * Repeat this response N times before consuming the next entry. Lets long
   * outage scenarios (>60s) stay terse in JSON.
   */
  repeat?: number;
  /**
   * Optional assertion: if set, the server records a violation when the
   * incoming `marker` query param does not match. Inspected via
   * `getRequests()` in tests; not enforced at the wire level.
   */
  expectMarker?: number | null;
};

export type FakeMaxScenario = {
  description: string;
  responses: FakeMaxResponseSpec[];
  /**
   * Behaviour after `responses` is fully consumed.
   * - `idle` (default): respond `200 { updates: [], marker: <last> }` so
   *   the supervisor keeps long-polling silently.
   * - `loop`: replay the queue from the start. Useful for marker-replay.
   */
  exhaustionPolicy?: "idle" | "loop";
};

export type FakeMaxRequestRecord = {
  method: string;
  path: string;
  marker: number | null;
  timeout: number | null;
  limit: number | null;
  types: string | null;
  authorization: string | null;
  receivedAt: number;
};

export type FakeMaxAssertion = {
  kind: "marker_mismatch";
  expected: number | null;
  actual: number | null;
  index: number;
};

export type FakeMaxServerHandle = {
  url: string;
  port: number;
  /** Resolves when the HTTP listener is shut down and all in-flight responses settle. */
  stop: () => Promise<void>;
  /** Snapshot of all observed requests in arrival order. */
  getRequests: () => FakeMaxRequestRecord[];
  /** Soft assertions raised by `expectMarker` mismatches. Tests inspect this. */
  getAssertions: () => FakeMaxAssertion[];
};

export type FakeMaxStartOptions = {
  /** Either an absolute path to scenario JSON or a parsed scenario object. */
  scenarioPath?: string;
  scenario?: FakeMaxScenario;
  /** TCP port; default 0 = ephemeral. */
  port?: number;
  /** Bind host; default 127.0.0.1. */
  host?: string;
};

const DEFAULT_HOST = "127.0.0.1";
const JSON_CONTENT_TYPE = "application/json";

function parseInteger(raw: string | string[] | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseString(raw: string | string[] | undefined): string | null {
  if (raw === undefined) {
    return null;
  }
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
}

function loadScenario(opts: FakeMaxStartOptions): FakeMaxScenario {
  if (opts.scenario) {
    return opts.scenario;
  }
  if (!opts.scenarioPath) {
    throw new Error("fake-max-server: provide either `scenario` or `scenarioPath`.");
  }
  const raw = readFileSync(resolve(opts.scenarioPath), "utf8");
  const parsed = JSON.parse(raw) as FakeMaxScenario;
  validateScenario(parsed, opts.scenarioPath);
  return parsed;
}

function validateScenario(scenario: FakeMaxScenario, source: string): void {
  if (typeof scenario.description !== "string") {
    throw new Error(`fake-max-server: scenario at ${source} missing 'description'.`);
  }
  if (!Array.isArray(scenario.responses) || scenario.responses.length === 0) {
    throw new Error(`fake-max-server: scenario at ${source} must have non-empty 'responses'.`);
  }
  for (const [idx, entry] of scenario.responses.entries()) {
    if (entry.repeat !== undefined && (!Number.isInteger(entry.repeat) || entry.repeat < 1)) {
      throw new Error(
        `fake-max-server: scenario at ${source} response[${idx}] has invalid repeat ${String(entry.repeat)}.`,
      );
    }
    if (entry.delayMs !== undefined && entry.delayMs < 0) {
      throw new Error(
        `fake-max-server: scenario at ${source} response[${idx}] has negative delayMs.`,
      );
    }
  }
}

/**
 * Expand `{ repeat: N }` so the consumer iterator simply walks one entry per
 * request, keeping advance/exhaustion logic linear and easy to read.
 */
function expandResponses(responses: readonly FakeMaxResponseSpec[]): FakeMaxResponseSpec[] {
  const out: FakeMaxResponseSpec[] = [];
  for (const entry of responses) {
    const repeats = entry.repeat ?? 1;
    for (let i = 0; i < repeats; i += 1) {
      // Strip `repeat` so each consumed entry reflects the wire response only.
      const { repeat: _repeat, ...wire } = entry;
      out.push(wire);
    }
  }
  return out;
}

function buildIdleResponse(): FakeMaxResponseSpec {
  return { status: 200, body: { updates: [], marker: 0 } };
}

function writeJsonResponse(res: ServerResponse, spec: FakeMaxResponseSpec): void {
  const status = spec.status ?? 200;
  const headers: Record<string, string> = { ...spec.headers };
  let payload: string | null = null;
  if (spec.body !== undefined) {
    payload = JSON.stringify(spec.body);
    if (headers["Content-Type"] === undefined && headers["content-type"] === undefined) {
      headers["Content-Type"] = JSON_CONTENT_TYPE;
    }
  }
  res.writeHead(status, headers);
  if (payload === null) {
    res.end();
  } else {
    res.end(payload);
  }
}

export async function startFakeMaxServer(opts: FakeMaxStartOptions): Promise<FakeMaxServerHandle> {
  const scenario = loadScenario(opts);
  const queue = expandResponses(scenario.responses);
  const observed: FakeMaxRequestRecord[] = [];
  const assertions: FakeMaxAssertion[] = [];
  let cursor = 0;

  const consumeNext = (): FakeMaxResponseSpec => {
    if (cursor >= queue.length) {
      if (scenario.exhaustionPolicy === "loop") {
        cursor = 0;
      } else {
        return buildIdleResponse();
      }
    }
    const next = queue[cursor];
    cursor += 1;
    return next ?? buildIdleResponse();
  };

  const recordRequest = (req: IncomingMessage, marker: number | null): FakeMaxRequestRecord => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    const record: FakeMaxRequestRecord = {
      method: req.method ?? "GET",
      path: url.pathname,
      marker,
      timeout: parseInteger(url.searchParams.get("timeout") ?? undefined),
      limit: parseInteger(url.searchParams.get("limit") ?? undefined),
      types: parseString(url.searchParams.get("types") ?? undefined),
      authorization: parseString(req.headers.authorization),
      receivedAt: Date.now(),
    };
    observed.push(record);
    return record;
  };

  const handleUpdates = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    const marker = parseInteger(url.searchParams.get("marker") ?? undefined);
    recordRequest(req, marker);
    const responseIndex = cursor; // pre-advance index for assertion attribution
    const spec = consumeNext();

    if (spec.expectMarker !== undefined && spec.expectMarker !== marker) {
      assertions.push({
        kind: "marker_mismatch",
        expected: spec.expectMarker ?? null,
        actual: marker,
        index: responseIndex,
      });
    }

    if (spec.delayMs && spec.delayMs > 0) {
      // Cancel the delay when the client closes its socket so tests do not
      // keep pending timers alive after the supervisor aborts an in-flight
      // long-poll. `setTimeout(... { signal })` from node:timers/promises
      // throws AbortError on early cancellation, which we swallow.
      const delayCtrl = new AbortController();
      const onSocketClose = (): void => delayCtrl.abort();
      req.socket.once("close", onSocketClose);
      try {
        await setTimeoutPromise(spec.delayMs, undefined, { signal: delayCtrl.signal });
      } catch {
        // AbortError or unrelated rejection — fall through to the destroyed
        // check below; we never write to a closed socket.
      } finally {
        req.socket.removeListener("close", onSocketClose);
      }
    }

    if (res.destroyed) {
      return;
    }

    if (spec.closeConnection) {
      // Force the underlying TCP socket closed without sending headers so the
      // SDK's `fetch` rejects with `TypeError: fetch failed` (undici).
      req.socket.destroy();
      return;
    }

    writeJsonResponse(res, spec);
  };

  const server: Server = createServer((req, res) => {
    void Promise.resolve()
      .then(async () => {
        const url = new URL(req.url ?? "/", "http://placeholder");
        if (req.method === "GET" && url.pathname === "/updates") {
          await handleUpdates(req, res);
          return;
        }
        // Phase 1B.0 only fakes the polling endpoint. Outbound (POST /messages)
        // and uploads land in 1B.1; until then return a loud 501 to surface
        // misconfigured supervisor calls instead of silently passing.
        if (req.method === "POST" && url.pathname === "/messages") {
          recordRequest(req, null);
          writeJsonResponse(res, {
            status: 501,
            body: {
              code: "not_implemented",
              message: "fake-max-server: POST /messages is Phase 1B.1.",
            },
          });
          return;
        }
        recordRequest(req, null);
        writeJsonResponse(res, {
          status: 404,
          body: {
            code: "not_found",
            message: `fake-max-server: ${req.method ?? "GET"} ${url.pathname}`,
          },
        });
      })
      .catch((err: unknown) => {
        if (res.destroyed) {
          return;
        }
        res.writeHead(500, { "Content-Type": JSON_CONTENT_TYPE });
        res.end(
          JSON.stringify({
            code: "harness_error",
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(opts.port ?? 0, opts.host ?? DEFAULT_HOST, () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === "string") {
    throw new Error("fake-max-server: failed to bind ephemeral port.");
  }
  const port = address.port;
  const host = opts.host ?? DEFAULT_HOST;
  const url = `http://${host}:${port}`;

  return {
    url,
    port,
    getRequests: () => observed.slice(),
    getAssertions: () => assertions.slice(),
    stop: () =>
      new Promise<void>((resolveStop, rejectStop) => {
        server.close((err) => {
          if (err) {
            rejectStop(err);
            return;
          }
          resolveStop();
        });
        // `close` waits for in-flight responses to drain. Force-disconnect
        // any keep-alive sockets so dropped-connection scenarios shut down
        // promptly in CI.
        server.closeAllConnections?.();
      }),
  };
}

// ---------------------------------------------------------------------------
// CLI: `pnpm tsx extensions/max-messenger/test/fake-max-server/server.ts \
//        scenarios/<name>.json --port 9999`
// ---------------------------------------------------------------------------
async function runCli(argv: string[]): Promise<void> {
  const positional: string[] = [];
  let port = 9999;
  let host = DEFAULT_HOST;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") {
      const next = argv[++i];
      if (!next) {
        throw new Error("fake-max-server: --port requires a value.");
      }
      port = Number.parseInt(next, 10);
      continue;
    }
    if (arg === "--host") {
      const next = argv[++i];
      if (!next) {
        throw new Error("fake-max-server: --host requires a value.");
      }
      host = next;
      continue;
    }
    if (arg && !arg.startsWith("--")) {
      positional.push(arg);
    }
  }
  const scenarioPath = positional[0];
  if (!scenarioPath) {
    throw new Error("Usage: tsx server.ts <scenario.json> [--port 9999] [--host 127.0.0.1]");
  }
  const handle = await startFakeMaxServer({ scenarioPath, port, host });
  // Intentional CLI banner — this code only runs when invoked via `tsx server.ts ...`.
  console.log(`fake-max-server listening at ${handle.url} (scenario: ${scenarioPath})`);
  process.on("SIGINT", () => void handle.stop().then(() => process.exit(0)));
  process.on("SIGTERM", () => void handle.stop().then(() => process.exit(0)));
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  runCli(process.argv.slice(2)).catch((err: unknown) => {
    // Intentional CLI error path — only runs in the standalone CLI entry above.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
