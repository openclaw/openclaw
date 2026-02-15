import path from "path";
import type { ChiaWatcherConfig, CoinEvent } from "./src/types";
import { ChiaSubscriber } from "./src/subscriber";
import { TransactionStore } from "./src/store";
import { MemoHandlerRegistry } from "./src/memoHandlers";
import { NotificationEngine } from "./src/notifications";

export const id = "chia-watcher";
export const name = "Chia Watcher";

export function register(api: any) {
  const logger = api.logger ?? console;
  let subscriber: ChiaSubscriber | null = null;
  let store: TransactionStore | null = null;
  let handlers: MemoHandlerRegistry | null = null;
  let notifier: NotificationEngine | null = null;

  function getConfig(): ChiaWatcherConfig {
    const cfg = api.config?.plugins?.entries?.["chia-watcher"]?.config ?? {};
    return {
      enabled: cfg.enabled ?? false,
      network: cfg.network ?? "mainnet",
      wallets: cfg.wallets ?? [],
      autoStart: cfg.autoStart ?? true,
      notifyChannel: cfg.notifyChannel,
      notifyTo: cfg.notifyTo,
      dbPath: cfg.dbPath,
      memoHandlers: cfg.memoHandlers ?? [],
      minAmountXch: cfg.minAmountXch ?? 0,
      includeCATs: cfg.includeCATs ?? true,
      pollIntervalMs: cfg.pollIntervalMs ?? 30000,
    };
  }

  function initStore(config: ChiaWatcherConfig) {
    const dbPath = config.dbPath ?? path.join(api.dataDir ?? ".", "chia-watcher.db");
    store = new TransactionStore(dbPath);
    return store;
  }

  async function startWatcher() {
    const config = getConfig();
    if (!config.enabled || !config.wallets.length) {
      return { success: false, message: "Watcher not enabled or no wallets configured" };
    }

    if (subscriber?.getStatus().isRunning) {
      return { success: false, message: "Already running" };
    }

    // Init components
    if (!store) initStore(config);
    handlers = new MemoHandlerRegistry(config.memoHandlers);
    notifier = new NotificationEngine({
      api,
      channel: config.notifyChannel,
      to: config.notifyTo,
      logger,
    });

    // Load saved state
    const savedState = store!.getState(`lastUpdate_${config.network}`);
    const lastUpdate = savedState ? JSON.parse(savedState) : null;

    const certDir = path.join(api.dataDir ?? ".", "chia-watcher-certs");
    subscriber = new ChiaSubscriber({
      network: config.network,
      certDir,
      logger,
      lastUpdate,
    });

    // Handle coin events
    subscriber.on("coin", async (event: CoinEvent) => {
      // Filter by minimum amount
      if (config.minAmountXch && event.amountXch < config.minAmountXch) return;
      // Filter CATs if disabled
      if (!config.includeCATs && event.isCat) return;

      // Process through memo handlers
      const result = handlers!.process(event);
      event.matchedHandler = result.handlerName ?? undefined;

      // Save to DB
      store!.saveCoinEvent(event);

      // Save state
      const lastUp = subscriber!.getLastUpdate();
      if (lastUp) {
        store!.saveState(`lastUpdate_${config.network}`, JSON.stringify(lastUp));
      }

      // Send notification
      if (result.matched && result.formattedMessage) {
        await notifier!.sendCoinAlert(event, result.formattedMessage);
      }
    });

    subscriber.on("error", (err: Error) => {
      logger.error(`[chia-watcher] ${err.message}`);
    });

    subscriber.on("disconnected", () => {
      logger.warn("[chia-watcher] Peer disconnected, will attempt reconnect...");
    });

    try {
      // Merge config wallets + DB wallets
      const dbWallets = store!.getActiveWallets().map((w) => w.address);
      const allWallets = [...new Set([...config.wallets, ...dbWallets])];

      await subscriber.start(allWallets);
      return { success: true, message: `Watching ${allWallets.length} wallets on ${config.network}` };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  async function stopWatcher() {
    if (!subscriber) return { success: false, message: "Not running" };
    await subscriber.stop();
    subscriber = null;
    return { success: true, message: "Watcher stopped" };
  }

  // Register background service
  api.registerService({
    id: "chia-watcher",
    start: async () => {
      const config = getConfig();
      if (config.enabled && config.autoStart) {
        const result = await startWatcher();
        logger.info(`[chia-watcher] Auto-start: ${result.message}`);
      } else {
        logger.info("[chia-watcher] Not auto-starting (disabled or autoStart=false)");
      }
    },
    stop: async () => {
      try { await stopWatcher(); } catch {}
      try { store?.close(); } catch {}
      store = null;
    },
  });

  // Register slash commands
  api.registerCommand({
    name: "chia_watch",
    description: "Add a wallet address to watch",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      const address = ctx.args?.trim();
      if (!address?.startsWith("xch1")) {
        return { text: "Usage: /chia_watch xch1..." };
      }
      if (!store) initStore(getConfig());
      store!.addWallet(address);
      return { text: `✅ Now watching ${address.slice(0, 10)}...${address.slice(-6)}` };
    },
  });

  api.registerCommand({
    name: "chia_unwatch",
    description: "Stop watching a wallet address",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      const address = ctx.args?.trim();
      if (!address) return { text: "Usage: /chia_unwatch xch1..." };
      if (!store) initStore(getConfig());
      store!.removeWallet(address);
      return { text: `🛑 Stopped watching ${address.slice(0, 10)}...${address.slice(-6)}` };
    },
  });

  api.registerCommand({
    name: "chia_status",
    description: "Show Chia watcher status",
    requireAuth: true,
    handler: () => {
      if (!subscriber) return { text: "Chia Watcher is not running. Enable in config and restart." };
      const status = subscriber.getStatus();
      const stats = store?.getStats();
      return {
        text: [
          `⛏️ **Chia Watcher Status**`,
          `Network: ${status.network}`,
          `Running: ${status.isRunning ? "✅" : "❌"}`,
          `Peer: ${status.peerAddr ?? "none"}`,
          `Height: ${status.peakHeight?.toLocaleString() ?? "unknown"}`,
          `Wallets: ${status.walletCount}`,
          `Transactions: ${stats?.totalTx ?? 0}`,
          `Uptime: ${Math.floor(status.uptime / 60)}m`,
        ].join("\n"),
      };
    },
  });

  api.registerCommand({
    name: "chia_history",
    description: "Show recent transactions",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      if (!store) initStore(getConfig());
      const limit = parseInt(ctx.args?.trim() || "10", 10);
      const txs = store!.getRecentTransactions(Math.min(limit, 50));
      if (!txs.length) return { text: "No transactions recorded yet." };

      const lines = txs.map((tx: any) => {
        const addr = tx.address?.slice(0, 8) + "...";
        const amt = (tx.amount_xch ?? tx.amountXch ?? 0).toFixed(4);
        const memo = tx.memo_decoded ?? tx.memoDecoded ?? "(none)";
        return `• ${amt} XCH → ${addr} | ${memo}`;
      });

      return { text: `📜 Recent transactions:\n${lines.join("\n")}` };
    },
  });

  // Register RPC methods for programmatic control
  api.registerGatewayMethod("chia-watcher.start", async ({ respond }: any) => {
    const result = await startWatcher();
    respond(result.success, result);
  });

  api.registerGatewayMethod("chia-watcher.stop", async ({ respond }: any) => {
    const result = await stopWatcher();
    respond(result.success, result);
  });

  api.registerGatewayMethod("chia-watcher.status", ({ respond }: any) => {
    const status = subscriber?.getStatus() ?? { isRunning: false };
    const stats = store?.getStats();
    respond(true, { ...status, stats });
  });

  logger.info("[chia-watcher] Plugin registered");
}
