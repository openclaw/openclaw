import { serve } from "@hono/node-server";
import { append, computeBalances, readAll } from "@lobstah/ledger";
import {
  ChatCompletionRequestSchema,
  type Identity,
  isReceiptFresh,
  RECEIPT_HEADER,
  RECEIPT_SSE_PREFIX,
  REQUESTER_HEADER,
  type SignedReceipt,
  formatPubkey,
  verifyReceipt,
} from "@lobstah/protocol";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { noteNonce } from "./nonce-store.js";
import { getCapacity, markFailed, markSucceeded } from "./peer-state.js";
import { loadPeers, type Peer } from "./peers.js";
import { candidatesForModel, orderCandidates } from "./pick.js";

export type RouterOptions = {
  identity: Identity;
  port?: number;
  host?: string;
};

export type RunningRouter = {
  port: number;
  pubkey: string;
  stop: () => Promise<void>;
};

export type BuildRouterAppOptions = {
  identity: Identity;
};

export type RouterApp = {
  app: Hono;
  pubkey: string;
};

const DEFAULT_PORT = 17475;

const tryAcceptReceipt = async (
  b64: string,
  ourPubkey: string,
  peerPubkey: string,
): Promise<void> => {
  let signed: SignedReceipt;
  try {
    signed = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as SignedReceipt;
  } catch {
    process.stderr.write(`router: malformed receipt from ${peerPubkey}\n`);
    return;
  }
  if (!verifyReceipt(signed)) {
    process.stderr.write(`router: rejected receipt from ${peerPubkey} (bad signature)\n`);
    return;
  }
  if (signed.receipt.requesterPubkey !== ourPubkey) {
    process.stderr.write(`router: rejected receipt from ${peerPubkey} (requester mismatch)\n`);
    return;
  }
  if (!isReceiptFresh(signed.receipt)) {
    process.stderr.write(`router: rejected receipt from ${peerPubkey} (expired or future-dated)\n`);
    return;
  }
  if (noteNonce(signed.receipt.nonce) === "replay") {
    process.stderr.write(`router: rejected receipt from ${peerPubkey} (nonce replay)\n`);
    return;
  }
  await append(signed);
};

type UpstreamAttempt = {
  upstream?: Response;
  peer?: Peer;
  errors: { peer: string; message: string }[];
};

const openUpstreamWithFallback = async (
  candidates: Peer[],
  body: unknown,
  ourPubkey: string,
): Promise<UpstreamAttempt> => {
  const errors: { peer: string; message: string }[] = [];
  for (const peer of candidates) {
    const target = `${peer.url.replace(/\/$/, "")}/v1/chat/completions`;
    try {
      const r = await fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [REQUESTER_HEADER]: ourPubkey,
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        markFailed(peer.pubkey);
        errors.push({
          peer: peer.pubkey.slice(0, 16),
          message: `${r.status} ${text.slice(0, 120)}`,
        });
        continue;
      }
      markSucceeded(peer.pubkey);
      return { upstream: r, peer, errors };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      markFailed(peer.pubkey);
      errors.push({ peer: peer.pubkey.slice(0, 16), message: msg });
    }
  }
  return { errors };
};

export const buildRouterApp = (opts: BuildRouterAppOptions): RouterApp => {
  const ourPubkey = formatPubkey(opts.identity.publicKey);

  const app = new Hono();

  app.get("/", (c) => c.text("lobstah-router\n"));
  app.get("/pubkey", (c) => c.json({ pubkey: ourPubkey }));
  app.get("/peers", async (c) => c.json(await loadPeers()));

  app.get("/balance", async (c) => {
    const summary = computeBalances(await readAll());
    return c.json({
      pubkey: ourPubkey,
      totals: summary.totals,
      self: summary.perPeer.get(ourPubkey) ?? { pubkey: ourPubkey, earned: 0, spent: 0, net: 0 },
    });
  });

  app.get("/v1/models", async (c) => {
    const peers = await loadPeers();
    const seen = new Set<string>();
    const data: { id: string; object: "model"; owned_by: string }[] = [];
    await Promise.all(
      peers.map(async (peer) => {
        const cap = await getCapacity(peer);
        if (!cap) return;
        for (const m of cap.models) {
          if (seen.has(m)) continue;
          seen.add(m);
          data.push({
            id: m,
            object: "model",
            owned_by: `lobstah:${peer.label ?? peer.pubkey.slice(0, 12)}`,
          });
        }
      }),
    );
    return c.json({ object: "list", data });
  });

  app.post("/v1/chat/completions", async (c) => {
    const peers = await loadPeers();
    if (peers.length === 0) {
      return c.json({ error: { type: "no_peers", message: "no peers configured" } }, 503);
    }

    const raw = await c.req.json();
    const parsed = ChatCompletionRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const candidates = await candidatesForModel(peers, parsed.data.model);
    if (candidates.length === 0) {
      return c.json(
        {
          error: {
            type: "no_capable_peer",
            model: parsed.data.model,
            message: `no healthy peer reports support for model "${parsed.data.model}"`,
          },
        },
        503,
      );
    }

    const ordered = orderCandidates(candidates);
    const { upstream, peer, errors } = await openUpstreamWithFallback(
      ordered,
      parsed.data,
      ourPubkey,
    );

    if (!upstream || !peer) {
      return c.json(
        {
          error: {
            type: "all_peers_failed",
            attempts: errors.length,
            errors,
          },
        },
        502,
      );
    }

    if (parsed.data.stream && upstream.body) {
      const upstreamBody = upstream.body;
      const peerPubkey = peer.pubkey;
      return streamSSE(c, async (sse) => {
        const reader = upstreamBody.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);

            if (event.startsWith(`${RECEIPT_SSE_PREFIX}:`)) {
              const b64 = event.slice(RECEIPT_SSE_PREFIX.length + 1).trim();
              await tryAcceptReceipt(b64, ourPubkey, peerPubkey);
              continue;
            }
            await sse.write(`${event}\n\n`);
          }
        }
      });
    }

    const upstreamBody = await upstream.text();
    const upstreamCT = upstream.headers.get("content-type") ?? "application/json";
    const receiptHdr = upstream.headers.get(RECEIPT_HEADER);

    if (receiptHdr) {
      await tryAcceptReceipt(receiptHdr, ourPubkey, peer.pubkey);
    }

    const headers: Record<string, string> = { "content-type": upstreamCT };
    if (receiptHdr) headers[RECEIPT_HEADER] = receiptHdr;
    return new Response(upstreamBody, { status: upstream.status, headers });
  });

  return { app, pubkey: ourPubkey };
};

export const startRouter = async (opts: RouterOptions): Promise<RunningRouter> => {
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? "127.0.0.1";
  const built = buildRouterApp({ identity: opts.identity });
  const server = serve({ fetch: built.app.fetch, hostname: host, port });
  return {
    port,
    pubkey: built.pubkey,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
};
