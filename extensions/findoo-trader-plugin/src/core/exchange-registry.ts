import type { ExchangeConfig, ExchangeId } from "../types.js";

/**
 * Manages CCXT exchange instances. Lazily creates and caches connections.
 * All exchange credentials are stored locally — never transmitted.
 */
export class ExchangeRegistry {
  private configs = new Map<string, ExchangeConfig>();
  private instances = new Map<string, unknown>();

  addExchange(id: string, config: ExchangeConfig): void {
    this.configs.set(id, config);
    // Clear cached instance so next access creates a fresh one.
    this.instances.delete(id);
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

    const instance = new (ExchangeClass as new (opts: Record<string, unknown>) => unknown)({
      apiKey: config.apiKey,
      secret: config.secret,
      password: config.passphrase,
      enableRateLimit: true,
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
