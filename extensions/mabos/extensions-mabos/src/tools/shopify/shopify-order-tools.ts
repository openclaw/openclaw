/**
 * Shopify Order Tools — 4 tools
 *
 * shopify_get_orders, shopify_get_order,
 * shopify_create_draft_order, shopify_complete_draft_order
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../common.js";
import { ShopifyClient } from "./client/ShopifyClient.js";
import { resolveShopifyCredentials } from "./shopify-credentials.js";

export function createShopifyOrderTools(api: OpenClawPluginApi): AnyAgentTool[] {
  const client = new ShopifyClient();

  async function creds() {
    const c = await resolveShopifyCredentials(api);
    if (!c) throw new Error("Shopify credentials not configured.");
    return c;
  }

  return [
    {
      name: "shopify_get_orders",
      label: "Shopify Get Orders",
      description:
        "Retrieve orders from the Shopify store with filtering, sorting, and pagination.",
      parameters: Type.Object({
        first: Type.Optional(
          Type.Number({ description: "Number of orders to return (default 50)" }),
        ),
        after: Type.Optional(Type.String({ description: "Pagination cursor" })),
        query: Type.Optional(
          Type.String({
            description: "Shopify query filter string (e.g. 'financial_status:paid')",
          }),
        ),
        sort_key: Type.Optional(
          Type.Union(
            [
              Type.Literal("PROCESSED_AT"),
              Type.Literal("TOTAL_PRICE"),
              Type.Literal("ID"),
              Type.Literal("CREATED_AT"),
              Type.Literal("UPDATED_AT"),
              Type.Literal("ORDER_NUMBER"),
            ],
            { description: "Sort key for ordering results" },
          ),
        ),
        reverse: Type.Optional(Type.Boolean({ description: "Reverse sort order" })),
      }),
      async execute(
        _id: string,
        params: {
          first?: number;
          after?: string;
          query?: string;
          sort_key?: string;
          reverse?: boolean;
        },
      ) {
        const { accessToken, shop } = await creds();
        const result = await client.loadOrders(accessToken, shop, {
          first: params.first,
          after: params.after,
          query: params.query,
          sortKey: params.sort_key as any,
          reverse: params.reverse,
        });
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_get_order",
      label: "Shopify Get Order",
      description: "Retrieve a single order by ID with optional field selection.",
      parameters: Type.Object({
        order_id: Type.String({ description: "Shopify order ID" }),
        fields: Type.Optional(
          Type.Array(Type.String(), { description: "Additional fields to include" }),
        ),
      }),
      async execute(_id: string, params: { order_id: string; fields?: string[] }) {
        const { accessToken, shop } = await creds();
        const result = await client.loadOrder(accessToken, shop, {
          orderId: params.order_id,
          fields: params.fields,
        });
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_create_draft_order",
      label: "Shopify Create Draft Order",
      description: "Create a draft order with line items, addresses, and customer info.",
      parameters: Type.Object({
        line_items: Type.Array(
          Type.Object({
            variant_id: Type.String({ description: "Product variant GID" }),
            quantity: Type.Number({ description: "Quantity" }),
            applied_discount: Type.Optional(
              Type.Object({
                title: Type.String(),
                value: Type.Number(),
                value_type: Type.Union([Type.Literal("FIXED_AMOUNT"), Type.Literal("PERCENTAGE")]),
              }),
            ),
          }),
        ),
        shipping_address: Type.Object({
          address1: Type.String(),
          country_code: Type.String(),
          first_name: Type.String(),
          last_name: Type.String(),
          zip: Type.String(),
          city: Type.String(),
          country: Type.String(),
          address2: Type.Optional(Type.String()),
          province: Type.Optional(Type.String()),
          province_code: Type.Optional(Type.String()),
          phone: Type.Optional(Type.String()),
        }),
        billing_address: Type.Object({
          address1: Type.String(),
          country_code: Type.String(),
          first_name: Type.String(),
          last_name: Type.String(),
          zip: Type.String(),
          city: Type.String(),
          country: Type.String(),
          address2: Type.Optional(Type.String()),
          province: Type.Optional(Type.String()),
          province_code: Type.Optional(Type.String()),
          phone: Type.Optional(Type.String()),
        }),
        email: Type.String({ description: "Customer email" }),
        tags: Type.Optional(Type.String({ description: "Comma-separated tags" })),
        note: Type.Optional(Type.String({ description: "Order note" })),
      }),
      async execute(_id: string, params: any) {
        const { accessToken, shop } = await creds();
        const payload = {
          lineItems: params.line_items.map((li: any) => ({
            variantId: li.variant_id,
            quantity: li.quantity,
            ...(li.applied_discount
              ? {
                  appliedDiscount: {
                    title: li.applied_discount.title,
                    value: li.applied_discount.value,
                    valueType: li.applied_discount.value_type,
                  },
                }
              : {}),
          })),
          shippingAddress: {
            address1: params.shipping_address.address1,
            address2: params.shipping_address.address2,
            countryCode: params.shipping_address.country_code,
            firstName: params.shipping_address.first_name,
            lastName: params.shipping_address.last_name,
            zip: params.shipping_address.zip,
            city: params.shipping_address.city,
            country: params.shipping_address.country,
            province: params.shipping_address.province,
            provinceCode: params.shipping_address.province_code,
            phone: params.shipping_address.phone,
          },
          billingAddress: {
            address1: params.billing_address.address1,
            address2: params.billing_address.address2,
            countryCode: params.billing_address.country_code,
            firstName: params.billing_address.first_name,
            lastName: params.billing_address.last_name,
            zip: params.billing_address.zip,
            city: params.billing_address.city,
            country: params.billing_address.country,
            province: params.billing_address.province,
            provinceCode: params.billing_address.province_code,
            phone: params.billing_address.phone,
          },
          email: params.email,
          tags: params.tags ?? "",
          note: params.note ?? "",
        };
        const result = await client.createDraftOrder(accessToken, shop, payload);
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_complete_draft_order",
      label: "Shopify Complete Draft Order",
      description: "Complete (finalize) a draft order, converting it to a real order.",
      parameters: Type.Object({
        draft_order_id: Type.String({ description: "Draft order GID" }),
        variant_id: Type.String({ description: "Variant ID for availability check" }),
      }),
      async execute(_id: string, params: { draft_order_id: string; variant_id: string }) {
        const { accessToken, shop } = await creds();
        const result = await client.completeDraftOrder(
          accessToken,
          shop,
          params.draft_order_id,
          params.variant_id,
        );
        return textResult(JSON.stringify(result, null, 2));
      },
    },
  ];
}
