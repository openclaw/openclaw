import type { IncomingMessage, ServerResponse } from "node:http";
import type { EscrowManager } from "./escrow.js";
import type { MarketplaceRegistry, MarketplaceQuery, ServiceCategory } from "./marketplace.js";
import type { WalletManager } from "./wallet.js";

// ── Types ───────────────────────────────────────────────────────────

interface CommerceHttpDeps {
  wallet: WalletManager;
  marketplace: MarketplaceRegistry;
  escrow: EscrowManager;
  log: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}

interface RouteHandler {
  method: string;
  path: string;
  handler: (body: Record<string, unknown>) => Promise<unknown>;
}

// ── HTTP Handler Factory ────────────────────────────────────────────

export function createCommerceHttpHandler(deps: CommerceHttpDeps) {
  const { wallet, marketplace, escrow, log } = deps;

  const routes: RouteHandler[] = [
    // ── Wallet ──────────────────────────────────────────────────
    {
      method: "POST",
      path: "/commerce/wallet/create",
      handler: async () => {
        const info = wallet.create();
        log.info("wallet created", info.address);
        return { address: info.address, createdAt: info.createdAt };
      },
    },
    {
      method: "POST",
      path: "/commerce/wallet/import",
      handler: async (body) => {
        const key = body.privateKey as string;
        if (!key) throw new Error("privateKey required");
        const info = wallet.importKey(key);
        return { address: info.address };
      },
    },
    {
      method: "GET",
      path: "/commerce/wallet/balance",
      handler: async () => {
        return await wallet.getBalance();
      },
    },
    {
      method: "GET",
      path: "/commerce/wallet/address",
      handler: async () => {
        const address = wallet.getAddress();
        return { address, configured: !!address };
      },
    },

    // ── Marketplace ─────────────────────────────────────────────
    {
      method: "POST",
      path: "/commerce/marketplace/publish",
      handler: async (body) => {
        const listing = marketplace.publish({
          agentId: body.agentId as string,
          name: body.name as string,
          description: body.description as string,
          price: body.price as string,
          category: body.category as ServiceCategory,
          sellerAddress: (body.sellerAddress as string) ?? wallet.getAddress() ?? "",
        });
        log.info("service published", listing.id, listing.name);
        return listing;
      },
    },
    {
      method: "GET",
      path: "/commerce/marketplace/search",
      handler: async (body) => {
        const query = body as MarketplaceQuery;
        return marketplace.search(query);
      },
    },
    {
      method: "GET",
      path: "/commerce/marketplace/categories",
      handler: async () => {
        return marketplace.getCategories();
      },
    },
    {
      method: "GET",
      path: "/commerce/marketplace/listing",
      handler: async (body) => {
        const id = body.id as string;
        if (!id) throw new Error("id required");
        return marketplace.get(id);
      },
    },
    {
      method: "DELETE",
      path: "/commerce/marketplace/listing",
      handler: async (body) => {
        const id = body.id as string;
        if (!id) throw new Error("id required");
        return { removed: marketplace.remove(id) };
      },
    },

    // ── Trading (Escrow) ────────────────────────────────────────
    {
      method: "POST",
      path: "/commerce/trade/initiate",
      handler: async (body) => {
        const trade = escrow.initiateTrade({
          listingId: body.listingId as string,
          buyerAgentId: body.buyerAgentId as string,
          sellerAgentId: body.sellerAgentId as string,
          buyerAddress: (body.buyerAddress as string) ?? wallet.getAddress() ?? "",
          sellerAddress: body.sellerAddress as string,
          amount: body.amount as string,
        });
        log.info("trade initiated", trade.id, trade.amount, "CLAW");
        return trade;
      },
    },
    {
      method: "POST",
      path: "/commerce/trade/lock",
      handler: async (body) => {
        const tradeId = body.tradeId as string;
        if (!tradeId) throw new Error("tradeId required");
        const signer = wallet.getSigner();
        const trade = await escrow.lockTokens(tradeId, signer);
        log.info("tokens locked", trade.id, trade.txHashes.escrowCreate);
        return trade;
      },
    },
    {
      method: "POST",
      path: "/commerce/trade/deliver",
      handler: async (body) => {
        const tradeId = body.tradeId as string;
        if (!tradeId) throw new Error("tradeId required");
        return escrow.markDelivered(tradeId);
      },
    },
    {
      method: "POST",
      path: "/commerce/trade/release",
      handler: async (body) => {
        const tradeId = body.tradeId as string;
        if (!tradeId) throw new Error("tradeId required");
        const signer = wallet.getSigner();
        const trade = await escrow.releaseTokens(tradeId, signer);
        log.info("tokens released", trade.id, trade.txHashes.release);
        return trade;
      },
    },
    {
      method: "POST",
      path: "/commerce/trade/refund",
      handler: async (body) => {
        const tradeId = body.tradeId as string;
        if (!tradeId) throw new Error("tradeId required");
        const signer = wallet.getSigner();
        const trade = await escrow.refundTokens(tradeId, signer);
        log.info("tokens refunded", trade.id, trade.txHashes.refund);
        return trade;
      },
    },
    {
      method: "GET",
      path: "/commerce/trade/status",
      handler: async (body) => {
        const tradeId = body.tradeId as string;
        if (!tradeId) throw new Error("tradeId required");
        return escrow.getTrade(tradeId);
      },
    },
    {
      method: "GET",
      path: "/commerce/trade/active",
      handler: async () => {
        return escrow.getActiveTrades();
      },
    },
    {
      method: "GET",
      path: "/commerce/trade/history",
      handler: async (body) => {
        const agentId = body.agentId as string;
        if (!agentId) throw new Error("agentId required");
        return escrow.getTradesByAgent(agentId);
      },
    },
  ];

  // ── HTTP Request Handler ──────────────────────────────────────

  return {
    prefix: "/commerce",
    async handle(req: IncomingMessage, res: ServerResponse) {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const method = (req.method ?? "GET").toUpperCase();
      const pathname = url.pathname.replace(/\/$/, "");

      const route = routes.find((r) => r.method === method && r.path === pathname);

      if (!route) {
        // Also handle GET params via query string
        const getRoute = routes.find((r) => r.method === "GET" && r.path === pathname);
        if (getRoute && method === "GET") {
          try {
            const params = Object.fromEntries(url.searchParams.entries());
            const result = await getRoute.handler(params);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            log.error("commerce HTTP error", message);
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: message }));
          }
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }

      try {
        let body: Record<string, unknown> = {};
        if (method === "POST" || method === "DELETE") {
          body = await parseJsonBody(req);
        } else {
          body = Object.fromEntries(url.searchParams.entries());
        }

        const result = await route.handler(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log.error("commerce HTTP error", message);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      }
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
