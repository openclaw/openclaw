/**
 * Shopify Navigation Tools — 4 tools
 *
 * shopify_get_navigation_menus, shopify_create_navigation_menu,
 * shopify_get_menu_items, shopify_create_menu_item
 *
 * Note: Navigation menu APIs in ShopifyClient use mock/placeholder
 * implementations for some operations (Shopify 2024-04 API limitation).
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../common.js";
import { ShopifyClient } from "./client/ShopifyClient.js";
import { resolveShopifyCredentials } from "./shopify-credentials.js";

export function createShopifyNavTools(api: OpenClawPluginApi): AnyAgentTool[] {
  const client = new ShopifyClient();

  async function creds() {
    const c = await resolveShopifyCredentials(api);
    if (!c) throw new Error("Shopify credentials not configured.");
    return c;
  }

  return [
    {
      name: "shopify_get_navigation_menus",
      label: "Shopify Get Navigation Menus",
      description: "Retrieve navigation menus from the Shopify store.",
      parameters: Type.Object({}),
      async execute() {
        const { accessToken, shop } = await creds();
        const result = await client.loadNavMenus(accessToken, shop);
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_create_navigation_menu",
      label: "Shopify Create Navigation Menu",
      description: "Create a new navigation menu in the Shopify store.",
      parameters: Type.Object({
        title: Type.String({ description: "Menu title" }),
        handle: Type.Optional(Type.String({ description: "URL handle for the menu" })),
      }),
      async execute(_id: string, params: { title: string; handle?: string }) {
        const { accessToken, shop } = await creds();
        const result = await client.createNavMenu(accessToken, shop, {
          title: params.title,
          handle: params.handle,
        });
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_get_menu_items",
      label: "Shopify Get Menu Items",
      description: "Retrieve items from a specific navigation menu.",
      parameters: Type.Object({
        menu_id: Type.String({ description: "Navigation menu ID" }),
      }),
      async execute(_id: string, params: { menu_id: string }) {
        const { accessToken, shop } = await creds();
        const result = await client.loadMenuItems(accessToken, shop, params.menu_id);
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_create_menu_item",
      label: "Shopify Create Menu Item",
      description: "Add a new item to a navigation menu.",
      parameters: Type.Object({
        menu_id: Type.String({ description: "Parent menu ID" }),
        title: Type.String({ description: "Menu item title" }),
        url: Type.String({ description: "URL the menu item links to" }),
        parent_id: Type.Optional(Type.String({ description: "Parent item ID for nesting" })),
        position: Type.Optional(Type.Number({ description: "Position in menu" })),
      }),
      async execute(
        _id: string,
        params: {
          menu_id: string;
          title: string;
          url: string;
          parent_id?: string;
          position?: number;
        },
      ) {
        const { accessToken, shop } = await creds();
        const result = await client.createMenuItem(accessToken, shop, {
          menu_id: params.menu_id,
          title: params.title,
          url: params.url,
          parent_id: params.parent_id,
          position: params.position,
        });
        return textResult(JSON.stringify(result, null, 2));
      },
    },
  ];
}
