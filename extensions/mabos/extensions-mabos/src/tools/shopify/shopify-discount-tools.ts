/**
 * Shopify Discount Tools — 1 tool
 *
 * shopify_create_discount
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../common.js";
import { ShopifyClient } from "./client/ShopifyClient.js";
import { resolveShopifyCredentials } from "./shopify-credentials.js";

export function createShopifyDiscountTools(api: OpenClawPluginApi): AnyAgentTool[] {
  const client = new ShopifyClient();

  async function creds() {
    const c = await resolveShopifyCredentials(api);
    if (!c) throw new Error("Shopify credentials not configured.");
    return c;
  }

  return [
    {
      name: "shopify_create_discount",
      label: "Shopify Create Discount",
      description:
        "Create a basic discount code in the Shopify store with percentage or fixed amount value.",
      parameters: Type.Object({
        title: Type.String({ description: "Discount title" }),
        code: Type.String({ description: "The discount code customers will enter" }),
        starts_at: Type.String({ description: "ISO date when discount becomes active" }),
        ends_at: Type.Optional(Type.String({ description: "ISO date when discount expires" })),
        value_type: Type.Union([Type.Literal("percentage"), Type.Literal("fixed_amount")], {
          description: "Type of discount value",
        }),
        value: Type.Number({
          description: "Discount value (0-1 for percentage, positive number for fixed_amount)",
        }),
        usage_limit: Type.Optional(
          Type.Number({ description: "Max number of times discount can be used" }),
        ),
        include_collection_ids: Type.Optional(
          Type.Array(Type.String(), { description: "Collection IDs to include" }),
        ),
        exclude_collection_ids: Type.Optional(
          Type.Array(Type.String(), { description: "Collection IDs to exclude" }),
        ),
        applies_once_per_customer: Type.Optional(
          Type.Boolean({ description: "Limit to one use per customer" }),
        ),
        combines_with: Type.Optional(
          Type.Object({
            product_discounts: Type.Optional(Type.Boolean()),
            order_discounts: Type.Optional(Type.Boolean()),
            shipping_discounts: Type.Optional(Type.Boolean()),
          }),
        ),
      }),
      async execute(_id: string, params: any) {
        const { accessToken, shop } = await creds();
        const result = await client.createBasicDiscountCode(accessToken, shop, {
          title: params.title,
          code: params.code,
          startsAt: params.starts_at,
          endsAt: params.ends_at,
          valueType: params.value_type,
          value: params.value,
          usageLimit: params.usage_limit,
          includeCollectionIds: params.include_collection_ids ?? [],
          excludeCollectionIds: params.exclude_collection_ids ?? [],
          appliesOncePerCustomer: params.applies_once_per_customer ?? false,
          combinesWith: {
            productDiscounts: params.combines_with?.product_discounts ?? true,
            orderDiscounts: params.combines_with?.order_discounts ?? false,
            shippingDiscounts: params.combines_with?.shipping_discounts ?? true,
          },
        });
        return textResult(JSON.stringify(result, null, 2));
      },
    },
  ];
}
