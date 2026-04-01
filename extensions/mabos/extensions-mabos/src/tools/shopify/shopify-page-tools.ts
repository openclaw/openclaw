/**
 * Shopify Page Tools — 5 tools
 *
 * shopify_get_pages, shopify_get_page, shopify_create_page,
 * shopify_update_page, shopify_delete_page
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../common.js";
import { ShopifyClient } from "./client/ShopifyClient.js";
import { resolveShopifyCredentials } from "./shopify-credentials.js";

export function createShopifyPageTools(api: OpenClawPluginApi): AnyAgentTool[] {
  const client = new ShopifyClient();

  async function creds() {
    const c = await resolveShopifyCredentials(api);
    if (!c) throw new Error("Shopify credentials not configured.");
    return c;
  }

  return [
    {
      name: "shopify_get_pages",
      label: "Shopify Get Pages",
      description: "Retrieve content pages from the Shopify store.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Max pages to return (default 50)" })),
        next: Type.Optional(Type.String({ description: "Pagination cursor" })),
      }),
      async execute(_id: string, params: { limit?: number; next?: string }) {
        const { accessToken, shop } = await creds();
        const result = await client.loadPages(accessToken, shop, params.limit, params.next);
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_get_page",
      label: "Shopify Get Page",
      description: "Retrieve a single content page by ID.",
      parameters: Type.Object({
        page_id: Type.String({ description: "Shopify page ID" }),
      }),
      async execute(_id: string, params: { page_id: string }) {
        const { accessToken, shop } = await creds();
        const result = await client.getPage(accessToken, shop, params.page_id);
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_create_page",
      label: "Shopify Create Page",
      description: "Create a new content page in the Shopify store.",
      parameters: Type.Object({
        title: Type.String({ description: "Page title" }),
        body_html: Type.String({ description: "Page content in HTML" }),
        handle: Type.Optional(Type.String({ description: "URL handle for the page" })),
        author: Type.Optional(Type.String({ description: "Page author" })),
        published: Type.Optional(
          Type.Boolean({ description: "Whether the page is published (default true)" }),
        ),
        template_suffix: Type.Optional(Type.String({ description: "Theme template suffix" })),
      }),
      async execute(
        _id: string,
        params: {
          title: string;
          body_html: string;
          handle?: string;
          author?: string;
          published?: boolean;
          template_suffix?: string;
        },
      ) {
        const { accessToken, shop } = await creds();
        const result = await client.createPage(accessToken, shop, {
          title: params.title,
          body_html: params.body_html,
          handle: params.handle,
          author: params.author,
          published: params.published,
          template_suffix: params.template_suffix,
        });
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_update_page",
      label: "Shopify Update Page",
      description: "Update an existing content page.",
      parameters: Type.Object({
        page_id: Type.String({ description: "Page ID to update" }),
        title: Type.Optional(Type.String({ description: "New page title" })),
        body_html: Type.Optional(Type.String({ description: "New page content in HTML" })),
        handle: Type.Optional(Type.String({ description: "New URL handle" })),
        author: Type.Optional(Type.String({ description: "New author" })),
        published: Type.Optional(Type.Boolean({ description: "Published status" })),
      }),
      async execute(
        _id: string,
        params: {
          page_id: string;
          title?: string;
          body_html?: string;
          handle?: string;
          author?: string;
          published?: boolean;
        },
      ) {
        const { accessToken, shop } = await creds();
        const result = await client.updatePage(accessToken, shop, {
          id: params.page_id,
          title: params.title,
          body_html: params.body_html,
          handle: params.handle,
          author: params.author,
          published: params.published,
        });
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_delete_page",
      label: "Shopify Delete Page",
      description: "Delete a content page from the Shopify store.",
      parameters: Type.Object({
        page_id: Type.String({ description: "Page ID to delete" }),
      }),
      async execute(_id: string, params: { page_id: string }) {
        const { accessToken, shop } = await creds();
        await client.deletePage(accessToken, shop, params.page_id);
        return textResult("Page deleted successfully.");
      },
    },
  ];
}
