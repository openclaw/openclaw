import type { ExchangeConfig, ExchangeId } from "../types.js";

type ExchangeHealthStoreLike = {
  get(exchangeId: string): { consecutiveFailures: number } | null;
};

/**
 * Manages CCXT exchange instances. Lazily creates and caches connections.
 * All exchange credentials are stored locally — never transmitted.
 *
 * When a healthStore is provided, getInstance() checks for consecutive
 * failures and rebuilds the connection if threshold is reached.
 */
export class ExchangeRegistry {
  private configs = new Map<string, ExchangeConfig>();
  private instances = new Map<string, unknown>();
  private healthStore?: ExchangeHealthStoreLike;

  constructor(healthStore?: ExchangeHealthStoreLike) {
    this.healthStore = healthStore;
  }

  addExchange(id: string, config: ExchangeConfig): void {
    this.configs.set(id, config);
    // Clear cached instance so next access creates a fresh one.
    this.instances.delete(id);
  }

  getConfig(id: string): ExchangeConfig | undefined {
    return this.configs.get(id);
  }

  removeExchange(id: string): boolean {
    this.instances.delete(id);
    return this.configs.delete(id);
  }

  listExchanges(): Array<{ id: string; exchange: ExchangeId; testnet: boolean }> {
    return Array.from(this.configs.entries()).map(([id, cfg]) => ({
      id,
      exchange: cfg.exchange,
      testnet: cfg.testnet ?? false,
    }));
  }

  /**
   * Get or create a CCXT exchange instance.
   * Lazily imports ccxt to avoid startup cost when trading is disabled.
   */
  async getInstance(id: string): Promise<unknown> {
    // Auto-reconnect: if health store shows ≥3 consecutive failures, drop cached instance
    if (this.healthStore) {
      const health = this.healthStore.get(id);
      if (health && health.consecutiveFailures >= 3 && this.instances.has(id)) {
        this.instances.delete(id);
      }
    }

    const cached = this.instances.get(id);
    if (cached) return cached;

    const config = this.configs.get(id);
    if (!config) {
      throw new Error(`Exchange "${id}" not configured. Run: openfinclaw exchange add ${id}`);
    }

    const ccxt = await import("ccxt");
    const ExchangeClass = (ccxt as Record<string, unknown>)[config.exchange];
    if (typeof ExchangeClass !== "function") {
      throw new Error(`Unsupported exchange: ${config.exchange}`);
    }

    const proxyUrl = config.httpProxy || process.env.HTTPS_PROXY || process.env.https_proxy;
    const instance = new (ExchangeClass as new (opts: Record<string, unknown>) => unknown)({
      apiKey: config.apiKey,
      secret: config.secret,
      password: config.passphrase,
      enableRateLimit: true,
      ...(proxyUrl ? { httpProxy: proxyUrl } : {}),
      options: {
        defaultType: config.defaultType ?? "spot",
        ...(config.subaccount ? { subaccount: config.subaccount } : {}),
      },
    });

    if (
      config.testnet &&
      typeof (instance as Record<string, unknown>).setSandboxMode === "function"
    ) {
      (instance as { setSandboxMode: (v: boolean) => void }).setSandboxMode(true);
    }

    this.instances.set(id, instance);
    return instance;
  }

  /** Close all exchange connections. */
  async closeAll(): Promise<void> {
    for (const [id, instance] of this.instances) {
      try {
        if (typeof (instance as Record<string, unknown>).close === "function") {
          await (instance as { close: () => Promise<void> }).close();
        }
      } catch {
        // Best-effort cleanup.
      }
      this.instances.delete(id);
    }
  }
}
