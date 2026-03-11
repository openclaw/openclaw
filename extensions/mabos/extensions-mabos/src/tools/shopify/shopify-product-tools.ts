/**
 * Shopify Product Tools — 4 tools
 *
 * shopify_get_products, shopify_get_products_by_collection,
 * shopify_get_products_by_ids, shopify_get_variants_by_ids
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../common.js";
import { ShopifyClient } from "./client/ShopifyClient.js";
import { resolveShopifyCredentials } from "./shopify-credentials.js";

export function createShopifyProductTools(api: OpenClawPluginApi): AnyAgentTool[] {
  const client = new ShopifyClient();

  async function creds() {
    const c = await resolveShopifyCredentials(api);
    if (!c)
      throw new Error(
        "Shopify credentials not configured. Set up a 'shopify' integration or SHOPIFY_STORE + SHOPIFY_ACCESS_TOKEN env vars.",
      );
    return c;
  }

  return [
    {
      name: "shopify_get_products",
      label: "Shopify Get Products",
      description:
        "Search and retrieve products from the Shopify store. Optionally filter by title.",
      parameters: Type.Object({
        search_title: Type.Optional(
          Type.String({ description: "Filter products by title (partial match)" }),
        ),
        limit: Type.Optional(Type.Number({ description: "Max products to return (default 10)" })),
        after_cursor: Type.Optional(
          Type.String({ description: "Pagination cursor for next page" }),
        ),
      }),
      async execute(
        _id: string,
        params: { search_title?: string; limit?: number; after_cursor?: string },
      ) {
        const { accessToken, shop } = await creds();
        const result = await client.loadProducts(
          accessToken,
          shop,
          params.search_title ?? null,
          params.limit ?? 10,
          params.after_cursor,
        );
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_get_products_by_collection",
      label: "Shopify Get Products by Collection",
      description: "Retrieve products belonging to a specific collection.",
      parameters: Type.Object({
        collection_id: Type.String({ description: "Shopify collection ID" }),
        limit: Type.Optional(Type.Number({ description: "Max products to return (default 10)" })),
        after_cursor: Type.Optional(
          Type.String({ description: "Pagination cursor for next page" }),
        ),
      }),
      async execute(
        _id: string,
        params: { collection_id: string; limit?: number; after_cursor?: string },
      ) {
        const { accessToken, shop } = await creds();
        const result = await client.loadProductsByCollectionId(
          accessToken,
          shop,
          params.collection_id,
          params.limit ?? 10,
          params.after_cursor,
        );
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_get_products_by_ids",
      label: "Shopify Get Products by IDs",
      description: "Retrieve specific products by their Shopify GIDs.",
      parameters: Type.Object({
        product_ids: Type.Array(Type.String(), {
          description: "Array of Shopify product GIDs (e.g. gid://shopify/Product/123)",
        }),
      }),
      async execute(_id: string, params: { product_ids: string[] }) {
        const { accessToken, shop } = await creds();
        const result = await client.loadProductsByIds(accessToken, shop, params.product_ids);
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_get_variants_by_ids",
      label: "Shopify Get Variants by IDs",
      description:
        "Retrieve specific product variants by their Shopify GIDs, including parent product details.",
      parameters: Type.Object({
        variant_ids: Type.Array(Type.String(), {
          description: "Array of Shopify variant GIDs (e.g. gid://shopify/ProductVariant/123)",
        }),
      }),
      async execute(_id: string, params: { variant_ids: string[] }) {
        const { accessToken, shop } = await creds();
        const result = await client.loadVariantsByIds(accessToken, shop, params.variant_ids);
        return textResult(JSON.stringify(result, null, 2));
      },
    },
  ];
}
