import { serve } from "@hono/node-server";
import { type SignedAnnouncement, parsePubkey, verify, fromHex } from "@lobstah/protocol";
import { Hono } from "hono";
import { TrackerRegistry } from "./registry.js";

export type TrackerOptions = {
  port?: number;
  host?: string;
};

export type RunningTracker = {
  port: number;
  registry: TrackerRegistry;
  stop: () => Promise<void>;
};

export type TrackerApp = {
  app: Hono;
  registry: TrackerRegistry;
};

const DEFAULT_PORT = 17476;
const enc = new TextEncoder();

export const buildTrackerApp = (): TrackerApp => {
  const registry = new TrackerRegistry();
  const app = new Hono();

  app.get("/", (c) => c.text(`lobstah-tracker (live peers: ${registry.size()})\n`));

  app.get("/peers", (c) => {
    const peers = registry.liveAnnouncements();
    return c.json({ version: 1, count: peers.length, peers });
  });

  app.post("/announce", async (c) => {
    let body: SignedAnnouncement;
    try {
      body = (await c.req.json()) as SignedAnnouncement;
    } catch {
      return c.json({ error: { type: "bad_json" } }, 400);
    }
    const result = registry.ingest(body);
    if (result !== "ok") {
      return c.json({ error: { type: "rejected", reason: result } }, 400);
    }
    return c.json({
      ok: true,
      pubkey: body.announcement.pubkey,
      ttlSeconds: body.announcement.ttlSeconds,
      registeredCount: registry.size(),
    });
  });

  // Withdraw an announcement. Body: { pubkey, signature, timestamp }
  // signature is over `unannounce:${pubkey}:${timestamp}` to prove ownership.
  app.post("/unannounce", async (c) => {
    let body: { pubkey: string; timestamp: number; signature: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: { type: "bad_json" } }, 400);
    }
    if (Math.abs(Date.now() - body.timestamp) > 5 * 60 * 1000) {
      return c.json({ error: { type: "rejected", reason: "stale" } }, 400);
    }
    try {
      const pk = parsePubkey(body.pubkey);
      const msg = enc.encode(`unannounce:${body.pubkey}:${body.timestamp}`);
      if (!verify(fromHex(body.signature), msg, pk)) {
        return c.json({ error: { type: "rejected", reason: "bad-signature" } }, 400);
      }
    } catch {
      return c.json({ error: { type: "rejected", reason: "bad-signature" } }, 400);
    }
    const removed = registry.remove(body.pubkey);
    return c.json({ ok: true, removed });
  });

  return { app, registry };
};

export const startTracker = async (opts: TrackerOptions = {}): Promise<RunningTracker> => {
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? "0.0.0.0";
  const { app, registry } = buildTrackerApp();
  const server = serve({ fetch: app.fetch, hostname: host, port });
  return {
    port,
    registry,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
};
