/**
 * Shopify Admin Tools — barrel export
 *
 * Aggregates all 34 Shopify admin tools from 8 domain modules into a single
 * factory function for registration in the MABOS extension.
 */

import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { createShopifyCustomerTools } from "./shopify-customer-tools.js";
import { createShopifyDiscountTools } from "./shopify-discount-tools.js";
import { createShopifyNavTools } from "./shopify-nav-tools.js";
import { createShopifyOrderTools } from "./shopify-order-tools.js";
import { createShopifyPageTools } from "./shopify-page-tools.js";
import { createShopifyProductTools } from "./shopify-product-tools.js";
import { createShopifyStoreTools } from "./shopify-store-tools.js";
import { createShopifyThemeTools } from "./shopify-theme-tools.js";

export function createShopifyAdminTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    ...createShopifyProductTools(api),
    ...createShopifyCustomerTools(api),
    ...createShopifyOrderTools(api),
    ...createShopifyDiscountTools(api),
    ...createShopifyStoreTools(api),
    ...createShopifyPageTools(api),
    ...createShopifyNavTools(api),
    ...createShopifyThemeTools(api),
  ];
}
