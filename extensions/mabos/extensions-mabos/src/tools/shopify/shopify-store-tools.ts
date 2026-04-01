/**
 * Shopify Store Tools — 5 tools
 *
 * shopify_get_shop, shopify_get_shop_details, shopify_get_collections,
 * shopify_manage_webhook, shopify_custom_graphql
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../common.js";
import { ShopifyClient } from "./client/ShopifyClient.js";
import { resolveShopifyCredentials } from "./shopify-credentials.js";

export function createShopifyStoreTools(api: OpenClawPluginApi): AnyAgentTool[] {
  const client = new ShopifyClient();

  async function creds() {
    const c = await resolveShopifyCredentials(api);
    if (!c) throw new Error("Shopify credentials not configured.");
    return c;
  }

  return [
    {
      name: "shopify_get_shop",
      label: "Shopify Get Shop",
      description: "Retrieve basic shop info (name, domain, currency, address).",
      parameters: Type.Object({}),
      async execute() {
        const { accessToken, shop } = await creds();
        const result = await client.loadShop(accessToken, shop);
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_get_shop_details",
      label: "Shopify Get Shop Details",
      description: "Retrieve detailed shop information including shipping countries.",
      parameters: Type.Object({}),
      async execute() {
        const { accessToken, shop } = await creds();
        const result = await client.loadShopDetail(accessToken, shop);
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_get_collections",
      label: "Shopify Get Collections",
      description: "Retrieve product collections (smart and custom) from the store.",
      parameters: Type.Object({
        name: Type.Optional(Type.String({ description: "Filter by collection name" })),
        limit: Type.Optional(
          Type.Number({ description: "Max collections to return (default 50)" }),
        ),
        since_id: Type.Optional(Type.String({ description: "Retrieve collections after this ID" })),
        next: Type.Optional(Type.String({ description: "Pagination cursor" })),
      }),
      async execute(
        _id: string,
        params: { name?: string; limit?: number; since_id?: string; next?: string },
      ) {
        const { accessToken, shop } = await creds();
        const result = await client.loadCollections(
          accessToken,
          shop,
          {
            name: params.name,
            limit: params.limit ?? 50,
            sinceId: params.since_id,
          },
          params.next,
        );
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_manage_webhook",
      label: "Shopify Manage Webhook",
      description: "Subscribe, unsubscribe, or find webhooks for the Shopify store.",
      parameters: Type.Object({
        action: Type.Union(
          [Type.Literal("subscribe"), Type.Literal("unsubscribe"), Type.Literal("find")],
          { description: "Webhook action to perform" },
        ),
        topic: Type.Optional(
          Type.Union([Type.Literal("orders/updated")], {
            description: "Webhook topic (required for subscribe/find)",
          }),
        ),
        callback_url: Type.Optional(
          Type.String({ description: "Callback URL (required for subscribe/find)" }),
        ),
        webhook_id: Type.Optional(
          Type.String({ description: "Webhook ID (required for unsubscribe)" }),
        ),
      }),
      async execute(
        _id: string,
        params: {
          action: "subscribe" | "unsubscribe" | "find";
          topic?: string;
          callback_url?: string;
          webhook_id?: string;
        },
      ) {
        const { accessToken, shop } = await creds();

        if (params.action === "subscribe") {
          if (!params.callback_url || !params.topic) {
            return textResult("Error: callback_url and topic are required for subscribe.");
          }
          const result = await client.subscribeWebhook(
            accessToken,
            shop,
            params.callback_url,
            params.topic as any,
          );
          return textResult(JSON.stringify(result, null, 2));
        }

        if (params.action === "unsubscribe") {
          if (!params.webhook_id) {
            return textResult("Error: webhook_id is required for unsubscribe.");
          }
          await client.unsubscribeWebhook(accessToken, shop, params.webhook_id);
          return textResult("Webhook unsubscribed successfully.");
        }

        if (params.action === "find") {
          if (!params.callback_url || !params.topic) {
            return textResult("Error: callback_url and topic are required for find.");
          }
          const result = await client.findWebhookByTopicAndCallbackUrl(
            accessToken,
            shop,
            params.callback_url,
            params.topic as any,
          );
          return textResult(result ? JSON.stringify(result, null, 2) : "No webhook found.");
        }

        return textResult("Unknown action.");
      },
    },
    {
      name: "shopify_custom_graphql",
      label: "Shopify Custom GraphQL",
      description: "Execute a custom GraphQL query or mutation against the Shopify Admin API.",
      parameters: Type.Object({
        query: Type.String({ description: "GraphQL query or mutation string" }),
        variables: Type.Optional(Type.Any({ description: "Variables for the GraphQL query" })),
      }),
      async execute(_id: string, params: { query: string; variables?: Record<string, any> }) {
        const { accessToken, shop } = await creds();
        // Need myshopify domain for GraphQL
        const shopInfo = await client.loadShop(accessToken, shop);
        const myshopifyDomain = shopInfo.shop.myshopify_domain;
        const result = await client.shopifyGraphqlRequest({
          url: `https://${myshopifyDomain}/admin/api/2024-04/graphql.json`,
          accessToken,
          query: params.query,
          variables: params.variables,
        });
        return textResult(JSON.stringify(result.data, null, 2));
      },
    },
  ];
}
