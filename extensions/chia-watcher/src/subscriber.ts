import {
  Address,
  Certificate,
  Clvm,
  Coin,
  CoinStateFilters,
  Connector,
  Peer,
  PeerOptions,
  toHex,
  fromHex,
} from "chia-wallet-sdk";
import dns from "dns/promises";
import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import type { CoinEvent, WatcherStatus } from "./types";
import { MAINNET_CONFIG, TESTNET_CONFIG, LIMITS } from "./types";

export interface SubscriberEvents {
  coin: (event: CoinEvent) => void;
  connected: (peerAddr: string, height: number) => void;
  disconnected: () => void;
  error: (err: Error) => void;
  heightUpdate: (height: number) => void;
}

export class ChiaSubscriber extends EventEmitter {
  private peer: any = null;
  private peerAddr: string | null = null;
  private peakHeight: number = 0;
  private peakHash: Uint8Array | null = null;
  private isRunning = false;
  private startTime: Date | null = null;
  private transactionCount = 0;
  private errorCount = 0;
  private lastUpdate: { previousHeight: number; headerHash: string } | null = null;
  private puzzleHashes = new Set<string>();
  private closed = false;
  private network: "mainnet" | "testnet11";
  private certDir: string;
  private logger: any;
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private walletAddresses: string[] = [];
  private networkConfig: any;
  private cert: any;
  private pendingEvents = 0;

  constructor(opts: {
    network: "mainnet" | "testnet11";
    certDir: string;
    logger?: any;
    lastUpdate?: { previousHeight: number; headerHash: string } | null;
  }) {
    super();
    this.network = opts.network;
    this.certDir = opts.certDir;
    this.logger = opts.logger ?? console;
    this.lastUpdate = opts.lastUpdate ?? null;
  }

  async start(wallets: string[]): Promise<void> {
    if (this.isRunning) return;

    if (wallets.length > LIMITS.MAX_WALLETS) {
      throw new Error(`Maximum ${LIMITS.MAX_WALLETS} wallets allowed, got ${wallets.length}`);
    }
    this.walletAddresses = wallets;
    this.networkConfig = this.network === "testnet11" ? TESTNET_CONFIG : MAINNET_CONFIG;
    this.cert = this.loadOrGenerateCert();

    await this.connectAndSubscribe();
  }

  private async connectAndSubscribe(): Promise<void> {
    // Try connecting to a random peer (up to 10 attempts)
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const ips = await this.lookupIntroducer(this.networkConfig.introducer);
        if (!ips.length) throw new Error("No peers from DNS introducer");

        const ip = ips[Math.floor(Math.random() * ips.length)];
        const socketAddr = ip.includes(":") ? `[${ip}]:${this.networkConfig.port}` : `${ip}:${this.networkConfig.port}`;

        const connector = new Connector(this.cert);
        const options = new PeerOptions();
        this.peer = await Peer.connect(this.networkConfig.networkId, socketAddr, connector, options);

        const event = await this.peer.next();
        if (!event?.newPeakWallet) throw new Error("No initial peak");

        this.peakHeight = event.newPeakWallet.height;
        this.peakHash = event.newPeakWallet.peakHash ?? null;
        this.peerAddr = socketAddr;
        this.isRunning = true;
        this.closed = false;
        this.startTime = this.startTime ?? new Date();

        this.logger.info(`[chia-watcher] Connected to ${socketAddr} at height ${this.peakHeight}`);
        this.emit("connected", socketAddr, this.peakHeight);

        // Subscribe to wallets BEFORE starting event loop
        // This ensures we don't miss events
        await this.subscribeWallets(this.walletAddresses, this.networkConfig);

        // Now start consuming events
        this.startEventLoop();

        // Start heartbeat monitor
        if (this.monitorInterval) clearInterval(this.monitorInterval);
        this.monitorInterval = setInterval(() => {
          if (this.closed && this.isRunning) {
            this.handleDisconnect();
          }
        }, 30000);

        return;
      } catch (err: any) {
        this.logger.warn(`[chia-watcher] Connection attempt ${attempt + 1}/10 failed: ${err.message}`);
      }
    }

    throw new Error("Failed to connect after 10 attempts");
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.monitorInterval) clearInterval(this.monitorInterval);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.peer && !this.closed) {
      try {
        await this.peer.removePuzzleSubscriptions(null);
      } catch {}
    }
    this.closed = true;
    this.peer = null;
    this.puzzleHashes.clear();
    this.logger.info("[chia-watcher] Subscriber stopped");
  }

  getStatus(): WatcherStatus {
    const uptime = this.startTime ? Date.now() - this.startTime.getTime() : 0;
    return {
      isRunning: this.isRunning,
      startedAt: this.startTime?.toISOString() ?? null,
      network: this.network,
      walletCount: this.puzzleHashes.size,
      wallets: [],
      transactionCount: this.transactionCount,
      errorCount: this.errorCount,
      peakHeight: this.peakHeight || null,
      peerAddr: this.peerAddr,
      uptime: Math.floor(uptime / 1000),
    };
  }

  getLastUpdate() {
    return this.lastUpdate;
  }

  private startEventLoop() {
    const handleEvent = (event: any) => {
      if (!event) {
        this.closed = true;
        this.handleDisconnect();
        return;
      }

      if (event.newPeakWallet) {
        this.peakHeight = event.newPeakWallet.height;
        this.peakHash = event.newPeakWallet.peakHash ?? null;
        this.emit("heightUpdate", this.peakHeight);
      }

      if (event.coinStateUpdate) {
        this.lastUpdate = {
          previousHeight: event.coinStateUpdate.height,
          headerHash: toHex(event.coinStateUpdate.peakHash),
        };
        if (event.coinStateUpdate.items.length) {
          // Backpressure: drop events if queue is overwhelmed
          if (this.pendingEvents >= LIMITS.EVENT_QUEUE_MAX) {
            this.logger.warn(`[chia-watcher] Event queue full (${this.pendingEvents}), dropping batch`);
            this.errorCount++;
          } else {
            this.pendingEvents++;
            this.processCoinStates(event.coinStateUpdate.items)
              .catch((err) => {
                this.errorCount++;
                this.emit("error", err);
              })
              .finally(() => { this.pendingEvents--; });
          }
        }
      }

      // Continue consuming events
      if (this.peer && !this.closed) {
        this.peer.next().then(handleEvent).catch(() => {
          this.closed = true;
          this.handleDisconnect();
        });
      }
    };

    if (this.peer && !this.closed) {
      this.peer.next().then(handleEvent).catch(() => {
        this.closed = true;
        this.handleDisconnect();
      });
    }
  }

  private async subscribeWallets(addresses: string[], networkConfig: any) {
    const newHashes = addresses
      .map((addr) => toHex(Address.decode(addr).puzzleHash))
      .filter((h) => !this.puzzleHashes.has(h));

    if (!newHashes.length) return;

    // If no saved state, start from current peak (don't replay entire history)
    let previousHeight = this.lastUpdate?.previousHeight;
    let headerHash: Uint8Array;

    if (this.lastUpdate?.headerHash) {
      headerHash = fromHex(this.lastUpdate.headerHash.replace(/^0x/, ""));
    } else if (this.peakHash) {
      // Start from current tip - only get future coins
      previousHeight = this.peakHeight;
      headerHash = this.peakHash;
      this.logger.info(`[chia-watcher] No saved state, subscribing from current height ${this.peakHeight}`);
    } else {
      // Absolute fallback - use genesis (will be slow)
      headerHash = fromHex(networkConfig.genesisChallenge.replace(/^0x/, ""));
    }

    try {
      while (true) {
        const result = await this.peer.requestPuzzleState(
          newHashes.map((h) => fromHex(h)),
          previousHeight,
          headerHash,
          new CoinStateFilters(true, true, false, 0n),
          true
        );

        if (result.coinStates.length) {
          this.lastUpdate = {
            previousHeight: result.height,
            headerHash: toHex(result.headerHash),
          };
          await this.processCoinStates(result.coinStates);
        }

        if (result.isFinished) break;
        previousHeight = result.height;
        headerHash = result.headerHash;
      }
    } catch (err: any) {
      this.logger.warn(`[chia-watcher] Error during wallet subscription: ${err.message}`);
      // Don't throw - we're still connected, just failed to get historical state
    }

    for (const h of newHashes) this.puzzleHashes.add(h);
    this.logger.info(`[chia-watcher] Subscribed to ${newHashes.length} wallet puzzle hashes`);
  }

  private async processCoinStates(coinStates: any[]) {
    const clvm = new Clvm();

    for (const cs of coinStates) {
      try {
        // Skip spent coins (we only care about created/received)
        if (cs.spentHeight) continue;

        let parentPuzzle: any;
        let parentSolution: any;

        try {
          const result = await this.peer.requestPuzzleAndSolution(cs.coin.parentCoinInfo, cs.createdHeight ?? 0);
          parentPuzzle = clvm.deserialize(result.puzzle).puzzle();
          parentSolution = clvm.deserialize(result.solution);
        } catch {
          continue;
        }

        const isCat = !!parentPuzzle.parseCatInfo();
        const catInfo = parentPuzzle.parseCatInfo();
        const conditions = parentPuzzle.program.run(parentSolution, 11_000_000_000n, false).value.toList() ?? [];
        const createCoins = conditions.map((c: any) => c.parseCreateCoin()).filter(Boolean);
        const createCoin = createCoins.find((cc: any) =>
          new Coin(cs.coin.parentCoinInfo, cc.puzzleHash, cc.amount).coinId().equals(cs.coin.coinId())
        );

        if (!createCoin) continue;

        const memos = createCoin.memos?.toList() ?? [];
        const memo = isCat ? memos[1] : memos[0];
        const memoHex = memo ? memo.toAtom()?.toString("hex") : null;
        const memoDecoded = memoHex ? this.decodeHexMemo(memoHex) : null;

        const coinEvent: CoinEvent = {
          coinId: cs.coin.coinId().toString("hex"),
          address: new Address(cs.coin.puzzleHash, "xch").encode(),
          amount: Number(cs.coin.amount),
          amountXch: Number(cs.coin.amount) / 1_000_000_000_000,
          memoHex,
          memoDecoded,
          isCat,
          assetId: catInfo ? toHex(catInfo.assetId) : undefined,
          createdHeight: cs.createdHeight,
          spentHeight: cs.spentHeight,
          network: this.network,
          timestamp: new Date().toISOString(),
        };

        this.transactionCount++;
        this.emit("coin", coinEvent);
      } catch (err: any) {
        this.errorCount++;
        this.logger.warn(`[chia-watcher] Error processing coin state: ${err.message}`);
      }
    }
  }

  private handleDisconnect() {
    if (!this.isRunning) return;
    this.logger.warn("[chia-watcher] Peer disconnected, reconnecting in 30s...");
    this.emit("disconnected");
    if (this.monitorInterval) clearInterval(this.monitorInterval);
    this.monitorInterval = null;
    this.puzzleHashes.clear();
    this.peer = null;

    // Auto-reconnect after delay
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      if (!this.isRunning) return;
      try {
        await this.connectAndSubscribe();
        this.logger.info("[chia-watcher] Reconnected successfully");
      } catch (err: any) {
        this.logger.error(`[chia-watcher] Reconnect failed: ${err.message}`);
        // Try again in 60s
        this.reconnectTimer = setTimeout(() => this.handleDisconnect(), 60000);
      }
    }, 30000);
  }

  private loadOrGenerateCert(): any {
    const certPath = path.join(this.certDir, "watcher.crt");
    const keyPath = path.join(this.certDir, "watcher.key");

    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      return Certificate.load(certPath, keyPath);
    }

    fs.mkdirSync(this.certDir, { recursive: true });
    const cert = Certificate.generate();
    fs.writeFileSync(certPath, cert.certPem);
    fs.writeFileSync(keyPath, cert.keyPem);
    return cert;
  }

  private decodeHexMemo(hex: string): string | null {
    try {
      const clean = hex.replace(/\s/g, "");
      if (clean.length % 2 !== 0) return null;
      return Buffer.from(clean, "hex").toString("utf-8");
    } catch {
      return null;
    }
  }

  private async lookupIntroducer(introducer: string): Promise<string[]> {
    try {
      const ipv4 = await dns.resolve4(introducer);
      const ipv6 = await dns.resolve6(introducer).catch(() => []);
      return [...ipv4, ...ipv6].sort(() => Math.random() - 0.5);
    } catch {
      return [];
    }
  }
}
