/**
 * Shopify Customer Tools — 2 tools
 *
 * shopify_get_customers, shopify_tag_customer
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../common.js";
import { ShopifyClient } from "./client/ShopifyClient.js";
import { resolveShopifyCredentials } from "./shopify-credentials.js";

export function createShopifyCustomerTools(api: OpenClawPluginApi): AnyAgentTool[] {
  const client = new ShopifyClient();

  async function creds() {
    const c = await resolveShopifyCredentials(api);
    if (!c) throw new Error("Shopify credentials not configured.");
    return c;
  }

  return [
    {
      name: "shopify_get_customers",
      label: "Shopify Get Customers",
      description: "Retrieve customers from the Shopify store with pagination support.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Max customers to return (default 250)" })),
        next: Type.Optional(Type.String({ description: "Pagination cursor for next page" })),
      }),
      async execute(_id: string, params: { limit?: number; next?: string }) {
        const { accessToken, shop } = await creds();
        const result = await client.loadCustomers(accessToken, shop, params.limit, params.next);
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_tag_customer",
      label: "Shopify Tag Customer",
      description: "Add tags to a customer in the Shopify store.",
      parameters: Type.Object({
        customer_id: Type.String({
          description: "Shopify customer ID (numeric, without GID prefix)",
        }),
        tags: Type.Array(Type.String(), { description: "Tags to add to the customer" }),
      }),
      async execute(_id: string, params: { customer_id: string; tags: string[] }) {
        const { accessToken, shop } = await creds();
        const result = await client.tagCustomer(accessToken, shop, params.tags, params.customer_id);
        return textResult(result ? "Customer tagged successfully." : "Failed to tag customer.");
      },
    },
  ];
}
