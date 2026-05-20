import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import {
  getPackageDetail,
  listPackages,
  openPackArtifactStream,
  resolvePackDir,
  scanNexusCatalog,
  type CatalogPackEntry,
} from "./catalog.js";

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export type NexusServer = {
  catalogRoot: string;
  entries: CatalogPackEntry[];
  refresh(): Promise<void>;
  listen(port: number, host?: string): Promise<ReturnType<typeof createServer>>;
};

export async function createNexusServer(catalogRoot: string): Promise<NexusServer> {
  const state: NexusServer = {
    catalogRoot,
    entries: [],
    async refresh() {
      state.entries = await scanNexusCatalog(catalogRoot);
    },
    async listen(port, host = "127.0.0.1") {
      await state.refresh();
      const server = createServer((req, res) => {
        void handleRequest(state, req, res);
      });
      await new Promise<void>((resolve) => server.listen(port, host, resolve));
      return server;
    },
  };
  await state.refresh();
  return state;
}

async function handleRequest(
  state: NexusServer,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = parseUrl(req);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (
      req.method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "packages" &&
      parts.length === 2
    ) {
      sendJson(res, 200, {
        packages: listPackages(state.entries, {
          family: url.searchParams.get("family") ?? undefined,
          q: url.searchParams.get("q") ?? undefined,
        }),
      });
      return;
    }

    if (
      req.method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "packages" &&
      parts.length === 3
    ) {
      const detail = getPackageDetail(state.entries, parts[2]!);
      if (!detail) {
        sendJson(res, 404, { error: "package not found", code: "NOT_FOUND" });
        return;
      }
      sendJson(res, 200, detail);
      return;
    }

    if (
      req.method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "packages" &&
      parts[3] === "versions" &&
      parts.length === 5
    ) {
      const slug = parts[2]!;
      const version = parts[4]!;
      const pack = resolvePackDir(state.entries, slug, version);
      if (!pack) {
        sendJson(res, 404, { error: "version not found", code: "NOT_FOUND" });
        return;
      }
      sendJson(res, 200, {
        slug,
        version,
        manifest: pack.manifest,
      });
      return;
    }

    if (
      req.method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "packages" &&
      parts[3] === "versions" &&
      parts[5] === "artifacts" &&
      parts.length === 7
    ) {
      const slug = parts[2]!;
      const version = parts[4]!;
      const hostKey = parts[6]!;
      const pack = resolvePackDir(state.entries, slug, version);
      if (!pack) {
        sendJson(res, 404, { error: "artifact not found", code: "NOT_FOUND" });
        return;
      }
      if (hostKey !== "generic" && hostKey !== "pack.tgz") {
        sendJson(res, 404, { error: `unknown artifact hostKey: ${hostKey}`, code: "NOT_FOUND" });
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("Content-Disposition", `attachment; filename="${slug}-${version}.tar.gz"`);
      await pipeline(openPackArtifactStream(pack.dir), res);
      return;
    }

    if (req.method === "GET" && parts[0] === "health") {
      sendJson(res, 200, { status: "ok", packs: state.entries.length, catalog: state.catalogRoot });
      return;
    }

    sendJson(res, 404, { error: "Not found", code: "NOT_FOUND" });
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
      code: "INTERNAL_ERROR",
    });
  }
}
