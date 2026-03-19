import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { BRAND, fetchShopifyProduct, listShopifyProducts } from "./brand-config.js";
import { textResult } from "./common.js";

export function createShopifyTools(_api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "shopify_catalog",
      label: "Shopify Product Catalog",
      description:
        "List products from the configured Shopify store. Returns title, handle, price, and image URL for content creation.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Max products (default 50)" })),
      }),
      async execute(_id: string, params: { limit?: number }) {
        const products = await listShopifyProducts(params.limit || 50);
        if (!products.length) return textResult("No products found or Shopify not configured.");
        return textResult(
          `## Shopify Catalog (${products.length} products)\n\n\`\`\`json\n${JSON.stringify(products, null, 2)}\n\`\`\``,
        );
      },
    },
    {
      name: "branded_post_preview",
      label: "Branded Post Preview",
      description:
        "Generate a branded social media caption for a Shopify product using configured templates (socialPost, adCopy, instagramCaption).",
      parameters: Type.Object({
        product_handle: Type.String({ description: "Shopify product handle" }),
        template: Type.Optional(
          Type.Union(
            [Type.Literal("socialPost"), Type.Literal("adCopy"), Type.Literal("instagramCaption")],
            { description: "Brand template (default: socialPost)" },
          ),
        ),
      }),
      async execute(_id: string, params: { product_handle: string; template?: string }) {
        const product = await fetchShopifyProduct(params.product_handle);
        if (!product) return textResult(`Product not found: ${params.product_handle}`);
        const tmpl = (params.template || "socialPost") as keyof typeof BRAND.templates;
        const caption = BRAND.templates[tmpl](product);
        return textResult(
          `## Branded Preview (${tmpl})\n\n${caption}\n\n**Product:** ${product.title}\n**Price:** $${product.price}\n**Image:** ${product.image_url}\n**All images:** ${product.images?.join(", ") || product.image_url}`,
        );
      },
    },
  ];
}
