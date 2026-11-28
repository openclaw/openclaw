import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import {
  acquireTestPortBlock,
  createFixtureLifetime,
  runQaGatewayFixture,
} from "openclaw/plugin-sdk/test-env";
import { vi } from "vitest";

type CatalogLoopback = {
  origin: string;
  requests: Array<[string, string, string]>;
  bodies: ReadableStream<Uint8Array>[];
  firstChunk: Promise<void>;
  track: <T>(original: Promise<T>) => Promise<T>;
  finish: () => void;
  drain: () => Promise<void>;
  readonly heldPending: boolean;
  readonly calls: number;
  readonly releases: number;
};

export async function withConfiguredCatalogLoopback(
  body: (fixture: CatalogLoopback) => Promise<void>,
  signal: AbortSignal,
) {
  const lifetime = createFixtureLifetime();
  const track = <T>(original: Promise<T>) => lifetime.track(original, true);
  const firstChunk = createDeferred();
  const requests: CatalogLoopback["requests"] = [];
  const bodies: CatalogLoopback["bodies"] = [];
  let claim: Awaited<ReturnType<typeof acquireTestPortBlock>> | undefined;
  let held: ServerResponse | undefined;
  let releases = 0;
  const finish = () => {
    if (held && !held.writableEnded) {
      held.end('{"id":"private/opaque-model","object":"model"}]}');
    }
  };
  const server = createServer((request, response) => {
    requests.push([request.url!, request.method!, request.headers.authorization!]);
    request.resume();
    void track(once(response, "finish"));
    response.setHeader("content-type", "application/json");
    if (request.url === "/held/models") {
      held = response;
      response.write('{"data":[');
    } else {
      response.end('{"data":[{"id":"private/opaque-model","object":"model"}]}');
    }
  });
  const closeServer = promisify(server.close.bind(server));
  await runQaGatewayFixture(
    async () => {
      clearLiveCatalogCacheForTests();
      claim = await acquireTestPortBlock({ offsets: [0], signal });
      const origin = `http://127.0.0.1:${claim.port}`;
      const actualGuard = ssrfRuntime.fetchWithSsrFGuard;
      const guard = vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation((params) => {
        // A wrong configured destination must fail before any external request.
        if (!params.url.startsWith(`${origin}/`)) {
          throw new Error("Catalog selected a foreign destination");
        }
        const acquired = track(
          actualGuard({
            ...params,
            requireHttps: false,
            policy: { allowPrivateNetwork: true, hostnameAllowlist: ["127.0.0.1"] },
            dispatcherPolicy: { mode: "direct" },
          }),
        );
        void track(
          acquired.then((result) => {
            const responseBody = result.response.body;
            if (!responseBody) {
              throw new Error("Catalog response has no body");
            }
            bodies.push(responseBody);
            const getReader = responseBody.getReader.bind(responseBody);
            vi.spyOn(responseBody, "getReader").mockImplementation((...args) => {
              const reader = getReader(...args);
              void track(reader.closed);
              const read = reader.read.bind(reader);
              vi.spyOn(reader, "read").mockImplementation(
                (...readArgs: Parameters<typeof read>) => {
                  const reading = Reflect.apply(read, reader, readArgs) as ReturnType<typeof read>;
                  const observed = track<Awaited<ReturnType<typeof read>>>(reading);
                  void track(
                    observed.then((chunk) => {
                      if (
                        params.url === `${origin}/held/models` &&
                        !chunk.done &&
                        (chunk.value as typeof chunk.value & { readonly length?: unknown }).length
                      ) {
                        firstChunk.resolve();
                      }
                    }),
                  );
                  return reading;
                },
              );
              return reader;
            });
            const release = result.release.bind(result);
            vi.spyOn(result, "release").mockImplementation((...args) => {
              releases += 1;
              return track(release(...args));
            });
          }),
        );
        return acquired;
      });
      const listening = track(once(server, "listening"));
      server.listen(claim.port, "127.0.0.1");
      await listening;
      await body({
        origin,
        requests,
        bodies,
        firstChunk: firstChunk.promise,
        track,
        finish,
        drain: () => lifetime.cleanup(),
        get heldPending() {
          return Boolean(held && !held.writableEnded);
        },
        get calls() {
          return guard.mock.calls.length;
        },
        get releases() {
          return releases;
        },
      });
    },
    finish,
    () => lifetime.cleanup(),
    () => {
      server.closeAllConnections();
      return server.listening ? closeServer() : undefined;
    },
    () => claim?.release(),
    () => vi.restoreAllMocks(),
    () => clearLiveCatalogCacheForTests(),
  );
}
