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

export function createManager(config: PaymentConfig): PaymentManager {
  const stripeLinkCfg = config.providers["stripe-link"];
  const stripeLinkAdapter = createStripeLinkAdapter({
    command: stripeLinkCfg.command,
    clientName: stripeLinkCfg.clientName,
    testMode: stripeLinkCfg.testMode,
    maxAmountCents: stripeLinkCfg.maxAmountCents,
  });

  return createPaymentManager({
    adapters: [mockPaymentAdapter, stripeLinkAdapter],
    config,
  });
}
