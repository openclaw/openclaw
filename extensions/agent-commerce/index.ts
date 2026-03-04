import type { OpenClawPluginApi } from "./src/openclaw-stubs.js";
import { createCommerceHttpHandler } from "./src/commerce-http.js";
import { EscrowManager } from "./src/escrow.js";
import { MarketplaceRegistry } from "./src/marketplace.js";
import { emptyPluginConfigSchema } from "./src/openclaw-stubs.js";
import { WalletManager } from "./src/wallet.js";

/**
 * Agent Commerce Plugin
 *
 * Provides blockchain-based agent-to-agent commerce via:
 *   - Wallet management (create/import/balance)
 *   - Marketplace registry (publish/search/buy services)
 *   - Escrow system (lock/release/refund CLAW tokens)
 *
 * All state is persisted under `~/.openclaw/agent-commerce/`.
 * HTTP endpoints are mounted at `/commerce/*`.
 */
const plugin = {
  id: "agent-commerce",
  name: "Agent Commerce",
  description: "Agent-to-agent commerce via ClawToken (ERC-20 + Escrow)",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const cfg = api.runtime.config.loadConfig();
    const pluginConfig = (cfg as Record<string, unknown>)["agent-commerce"] as
      | {
          rpcUrl?: string;
          contractAddress?: string;
          chainId?: number;
        }
      | undefined;

    // Resolve state directory
    const stateDir =
      api.runtime.paths?.stateDir ??
      (process.env.OPENCLAW_STATE_DIR ||
        `${process.env.HOME ?? process.env.USERPROFILE}/.openclaw`);

    // Initialize components
    const wallet = new WalletManager(stateDir, {
      rpcUrl: pluginConfig?.rpcUrl,
      contractAddress: pluginConfig?.contractAddress,
      chainId: pluginConfig?.chainId,
    });

    const marketplace = new MarketplaceRegistry(stateDir);

    const contractAddress = pluginConfig?.contractAddress ?? "";
    const escrow = contractAddress ? new EscrowManager(stateDir, contractAddress) : null;

    // Register HTTP handler
    const httpHandler = createCommerceHttpHandler({
      wallet,
      marketplace,
      escrow: escrow!,
      log: api.logger,
    });

    api.registerHttpHandler(httpHandler);

    api.logger.info(
      `[agent-commerce] Plugin registered.` +
        ` Wallet: ${wallet.hasWallet() ? wallet.getAddress() : "not created"}.` +
        ` Contract: ${contractAddress || "not deployed"}.` +
        ` Marketplace: ${marketplace.getActive().length} active listings.`,
    );
  },
};

export default plugin;
