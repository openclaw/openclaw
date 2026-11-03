import { createServer, type Server } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { expect, it, vi } from "vitest";
import { createClickClackClient } from "./http-client.js";

const dnsGate = vi.hoisted(() => ({ prepare: undefined as (() => Promise<void>) | undefined }));
// Delay external DNS preparation while preserving the real guard and HTTP transport.
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...actual,
    lookup: async (...args: Parameters<typeof actual.lookup>) => {
      await dnsGate.prepare?.();
      return actual.lookup(...args);
    },
  };
});

async function listenLoopbackServer(server: Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected loopback TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

it("follows same-origin API redirects but never reaches another private origin", async () => {
  const internalHits: string[] = [];
  const internal = createServer((req, res) => {
    internalHits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ user: { id: "metadata" } }));
  });
  const internalPort = await listenLoopbackServer(internal);
  const api = createServer((req, res) => {
    if (req.url === "/api/me") {
      res.writeHead(302, { location: "/api/v2/me" }).end();
    } else if (req.url === "/api/v2/me") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ user: { id: "bot" } }));
    } else {
      res.writeHead(302, { location: `http://127.0.0.1:${internalPort}/latest/meta-data/` });
      res.end();
    }
  });
  const apiPort = await listenLoopbackServer(api);
  const client = createClickClackClient({
    baseUrl: `http://127.0.0.1:${apiPort}`,
    token: "fake",
  });

  try {
    await expect(client.me()).resolves.toEqual({ id: "bot" });
    await expect(client.workspaces()).rejects.toThrow(/blocked/i);
    expect(internalHits).toEqual([]);
  } finally {
    api.close();
    internal.close();
  }
});

it.each([
  { hop: 0, retired: false },
  { hop: 0, retired: true },
  { hop: 1, retired: false },
  { hop: 1, retired: true },
])(
  "rechecks caller after DNS preparation (hop=$hop, retired=$retired)",
  async ({ hop, retired }) => {
    const preparing = createDeferred();
    const prepared = createDeferred();
    const caller = new AbortController();
    const failure = new Error("ClickClack caller retired");
    const requests: string[] = [];
    const initialPath = "/api/channels/chn_1/messages";
    const api = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (hop === 1 && req.url === initialPath) {
        res.writeHead(307, { location: "/redirected-message" }).end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: { id: "msg_1" } }));
      }
    });
    const port = await listenLoopbackServer(api);
    let lookups = 0;
    dnsGate.prepare = async () => {
      if (lookups++ === hop) {
        preparing.resolve();
        await prepared.promise;
      }
    };
    const client = createClickClackClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "fake",
      beforeRequest: () => caller.signal.throwIfAborted(),
    });
    const sending = client.createChannelMessage("chn_1", "hello").then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await Promise.race([
        preparing.promise,
        sending.then(() => {
          throw new Error("request finished before DNS preparation");
        }),
      ]);
      if (retired) {
        caller.abort(failure);
      }
      prepared.resolve();
      expect(await sending).toEqual(retired ? { error: failure } : { value: { id: "msg_1" } });
      const allowedPaths = hop === 0 ? [] : [`POST ${initialPath}`];
      expect(requests).toEqual(
        retired
          ? allowedPaths
          : [...allowedPaths, `POST ${hop === 0 ? initialPath : "/redirected-message"}`],
      );
    } finally {
      prepared.resolve();
      await sending;
      dnsGate.prepare = undefined;
      api.close();
    }
  },
);
