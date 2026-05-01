/**
 * manager-factory.ts — Builds a PaymentManager from PaymentConfig.
 *
 * Always includes the mock adapter (for testing and dev environments).
 * Includes the stripe-link adapter with config from providers["stripe-link"].
 */

import type { PaymentConfig } from "./config.js";
import { createPaymentManager } from "./payments.js";
import type { PaymentManager } from "./payments.js";
import { mockPaymentAdapter } from "./providers/mock.js";
import { createStripeLinkAdapter } from "./providers/stripe-link.js";
import { expandStorePath, initHandleStore } from "./store.js";

export function createManager(config: PaymentConfig): PaymentManager {
  const stripeLinkCfg = config.providers["stripe-link"];
  const stripeLinkAdapter = createStripeLinkAdapter({
    command: stripeLinkCfg.command,
    clientName: stripeLinkCfg.clientName,
    testMode: stripeLinkCfg.testMode,
    maxAmountCents: stripeLinkCfg.maxAmountCents,
  });

  // Initialize handle persistence (Codex P2-5): load existing handles from disk
  // so a fresh CLI process can pick up handles issued in a previous process.
  // Fire-and-forget: errors are logged but should not block manager creation.
  const storePath = expandStorePath(config.store);
  initHandleStore(storePath).catch((err) => {
    console.warn(`[payment] Failed to load handle store from ${storePath}: ${String(err)}`);
  });

  return createPaymentManager({
    adapters: [mockPaymentAdapter, stripeLinkAdapter],
    config,
  });
}
