import { realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { ControlUiRootState } from "../../src/gateway/server-control-ui-root.js";

/** Production HTTP delivery for immutable benchmark bundles in an isolated process. */
export async function startControlUiBenchGatewayServer(
  outDir: string,
  port = 0,
  assetLatencyMs = 0,
) {
  let readFixture:
    | ((pathname: string) =>
        | {
            body: string | Buffer;
            contentType: string;
            delayMs?: number;
            headers?: Record<string, string>;
          }
        | undefined)
    | undefined;
  const [
    { handleControlUiHttpRequest },
    { inspectControlUiRootAssets },
    { readControlUiRootAsset },
    lifecycle,
  ] = await Promise.all([
    import("../../src/gateway/control-ui.js"),
    import("../../src/infra/control-ui-assets.js"),
    import("../../src/gateway/server-control-ui-root.js"),
    import("../../src/shared/global-singleton.js"),
  ]);
  const roots = new Map<string, ControlUiRootState>();
  async function prepareRoot(directory: string): Promise<ControlUiRootState> {
    const rootPath = await realpath(path.resolve(directory));
    const existing = roots.get(rootPath);
    if (existing) {
      return existing;
    }
    const assets = inspectControlUiRootAssets(rootPath);
    if (assets.kind !== "ready") {
      throw new Error(`Benchmark Control UI bundle is not ready: ${rootPath} (${assets.kind})`);
    }
    const root: ControlUiRootState = {
      kind: "bundled",
      path: rootPath,
      realPath: rootPath,
      publicAssetBuildId: assets.publicAssetBuildId,
    };
    roots.set(rootPath, root);
    // Start the shared file reader before timing a reload; each bundle gets the same index read.
    await readControlUiRootAsset(root, "index.html", true);
    return root;
  }

  let currentRoot = await prepareRoot(outDir);
  let preloadHeadersEnabled = true;
  let terminalEnabled = false;
  let closing: Promise<void> | undefined;
  const requests: Array<{ method: string; url: string; navigationPreload: boolean }> = [];
  const serve = (request: IncomingMessage, response: ServerResponse) => {
    if (!preloadHeadersEnabled) {
      // Paired measurement of the pre-hints delivery path, with the same files.
      const setHeader = response.setHeader.bind(response);
      response.setHeader = (name, value) =>
        name.toLowerCase() === "link" ? response : setHeader(name, value);
    }
    requests.push({
      method: request.method ?? "GET",
      url: request.url ?? "/",
      navigationPreload: request.headers["service-worker-navigation-preload"] !== undefined,
    });
    const fixture = readFixture?.(new URL(request.url ?? "/", "http://localhost").pathname);
    if (fixture) {
      const send = () => {
        response.writeHead(200, {
          "Content-Type": fixture.contentType,
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
          "Cross-Origin-Resource-Policy": "cross-origin",
          ...fixture.headers,
        });
        response.end(request.method === "HEAD" ? undefined : fixture.body);
      };
      if (fixture.delayMs) {
        setTimeout(send, fixture.delayMs);
      } else {
        send();
      }
      return;
    }
    // Each admitted request retains its bundle even if the next document switches builds.
    // Match the synthetic Gateway fixture; a document/bootstrap mismatch triggers a reload.
    void handleControlUiHttpRequest(request, response, {
      root: currentRoot,
      terminalEnabled,
    }).then(
      (handled) => {
        if (!handled) {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Not Found");
        }
      },
      () => {
        if (response.headersSent) {
          response.destroy();
        } else {
          response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Control UI benchmark request failed");
        }
      },
    );
  };
  const server = createServer((request, response) => {
    if (assetLatencyMs > 0) {
      // Server-side delay also covers dedicated-worker module imports.
      setTimeout(() => serve(request, response), assetLatencyMs);
    } else {
      serve(request, response);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Control UI benchmark server did not bind a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    setPreloadHeadersEnabled(enabled: boolean) {
      preloadHeadersEnabled = enabled;
    },
    setTerminalEnabled(enabled: boolean) {
      terminalEnabled = enabled;
    },
    setFixtureReader(reader: typeof readFixture) {
      readFixture = reader;
    },
    async selectBuild(directory: string) {
      const root = await prepareRoot(directory);
      if (closing) {
        throw new Error("Control UI benchmark server is closing");
      }
      currentRoot = root;
    },
    close() {
      // The benchmark owns this process; retain warm root caches until all HTTP work ends.
      closing ??= (async () => {
        try {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        } finally {
          await lifecycle.drainGlobalSingletonLifecycleState();
        }
      })();
      return closing;
    },
  };
}
