import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { vi } from "vitest";

const TEST_GGUF_SHA256 = "b83633aa785344791618f2fddf131b010ea04912a60430760b070bad293f65bd";

export async function withHuggingFaceMetadataFixture(
  fixture: { cacheDir: string; servers: http.Server[] },
  endpoint: "manifest" | "file" | "tree",
  run: (params: {
    cacheDir: string;
    setMetadataAvailable: (available: boolean) => void;
    setPadding: (target: "manifest" | "file" | "tree", padding: string) => void;
    pathInfoBodies: unknown[];
    requestedUrls: string[];
    source: string;
  }) => Promise<void>,
  source = "hf:owner/repo",
): Promise<void> {
  const { cacheDir, servers } = fixture;
  await fs.writeFile(path.join(cacheDir, "hf_owner_repo_model.gguf"), "GGUF");
  let padding = "x".repeat(1024 * 1024);
  let metadataAvailable = true;
  const pathInfoBodies: unknown[] = [];
  const requestedUrls: string[] = [];
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    requestedUrls.push(req.url ?? "");
    if (!metadataAvailable) {
      res.statusCode = 503;
      res.end("{}");
      return;
    }
    if (req.url?.startsWith("/v2/owner/repo/manifests/latest")) {
      res.end(
        JSON.stringify({
          ggufFile: { rfilename: "model.gguf", size: 4 },
          ...(endpoint === "manifest" ? { padding } : {}),
        }),
      );
      return;
    }
    if (req.url?.startsWith("/api/models/owner/repo/paths-info/")) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        pathInfoBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.end(
          JSON.stringify([
            { path: "model.gguf", size: 4, lfs: { oid: TEST_GGUF_SHA256 } },
            ...(endpoint === "file" ? [padding] : []),
          ]),
        );
      });
      return;
    }
    if (req.url?.startsWith("/api/models/owner/repo/tree/")) {
      res.end(
        JSON.stringify([
          { path: "model.gguf", size: 4, lfs: { oid: TEST_GGUF_SHA256 } },
          ...(endpoint === "tree" ? [padding] : []),
        ]),
      );
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing test server address");
  }
  const realFetch = globalThis.fetch;
  const localFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const upstream = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    return await realFetch(`http://127.0.0.1:${address.port}${upstream.pathname}`, init);
  });
  vi.stubGlobal("fetch", localFetch);
  try {
    await run({
      cacheDir,
      setMetadataAvailable: (available) => {
        metadataAvailable = available;
      },
      setPadding: (target, next) => {
        if (target === endpoint) {
          padding = next;
        }
      },
      pathInfoBodies,
      requestedUrls,
      source,
    });
  } finally {
    vi.unstubAllGlobals();
  }
}
