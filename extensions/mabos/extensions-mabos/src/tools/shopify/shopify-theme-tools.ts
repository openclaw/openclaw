/**
 * Shopify Theme Tools — 9 tools
 *
 * shopify_get_themes, shopify_get_theme, shopify_create_theme,
 * shopify_duplicate_theme, shopify_get_theme_assets,
 * shopify_get_theme_asset, shopify_update_theme_asset,
 * shopify_get_theme_settings, shopify_update_theme_settings
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../common.js";
import { ShopifyClient } from "./client/ShopifyClient.js";
import { resolveShopifyCredentials } from "./shopify-credentials.js";

export function createShopifyThemeTools(api: OpenClawPluginApi): AnyAgentTool[] {
  const client = new ShopifyClient();

  async function creds() {
    const c = await resolveShopifyCredentials(api);
    if (!c) throw new Error("Shopify credentials not configured.");
    return c;
  }

  return [
    {
      name: "shopify_get_themes",
      label: "Shopify Get Themes",
      description: "List all themes installed on the Shopify store.",
      parameters: Type.Object({}),
      async execute() {
        const { accessToken, shop } = await creds();
        const result = await client.loadThemes(accessToken, shop);
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_get_theme",
      label: "Shopify Get Theme",
      description: "Retrieve details of a specific theme by ID.",
      parameters: Type.Object({
        theme_id: Type.String({ description: "Theme ID" }),
      }),
      async execute(_id: string, params: { theme_id: string }) {
        const { accessToken, shop } = await creds();
        const result = await client.getTheme(accessToken, shop, params.theme_id);
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_create_theme",
      label: "Shopify Create Theme",
      description: "Create a new theme on the Shopify store.",
      parameters: Type.Object({
        name: Type.String({ description: "Theme name" }),
        src: Type.Optional(
          Type.String({ description: "URL to a ZIP file containing theme assets" }),
        ),
        role: Type.Optional(
          Type.Union([Type.Literal("main"), Type.Literal("unpublished")], {
            description: "Theme role (default: unpublished)",
          }),
        ),
      }),
      async execute(
        _id: string,
        params: { name: string; src?: string; role?: "main" | "unpublished" },
      ) {
        const { accessToken, shop } = await creds();
        const result = await client.createTheme(accessToken, shop, {
          name: params.name,
          src: params.src,
          role: params.role,
        });
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_duplicate_theme",
      label: "Shopify Duplicate Theme",
      description: "Duplicate an existing theme with a new name.",
      parameters: Type.Object({
        theme_id: Type.String({ description: "Theme ID to duplicate" }),
        name: Type.String({ description: "Name for the duplicated theme" }),
      }),
      async execute(_id: string, params: { theme_id: string; name: string }) {
        const { accessToken, shop } = await creds();
        const result = await client.duplicateTheme(accessToken, shop, params.theme_id, params.name);
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_get_theme_assets",
      label: "Shopify Get Theme Assets",
      description: "List all assets (files) in a theme.",
      parameters: Type.Object({
        theme_id: Type.String({ description: "Theme ID" }),
      }),
      async execute(_id: string, params: { theme_id: string }) {
        const { accessToken, shop } = await creds();
        const result = await client.loadThemeAssets(accessToken, shop, params.theme_id);
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_get_theme_asset",
      label: "Shopify Get Theme Asset",
      description: "Retrieve a specific theme asset (file) by key.",
      parameters: Type.Object({
        theme_id: Type.String({ description: "Theme ID" }),
        asset_key: Type.String({ description: "Asset key path (e.g. 'templates/index.json')" }),
      }),
      async execute(_id: string, params: { theme_id: string; asset_key: string }) {
        const { accessToken, shop } = await creds();
        const result = await client.getThemeAsset(
          accessToken,
          shop,
          params.theme_id,
          params.asset_key,
        );
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_update_theme_asset",
      label: "Shopify Update Theme Asset",
      description:
        "Create or update a theme asset (file). Provide either value (text content) or attachment (base64).",
      parameters: Type.Object({
        theme_id: Type.String({ description: "Theme ID" }),
        key: Type.String({ description: "Asset key path" }),
        value: Type.Optional(Type.String({ description: "Text content for the asset" })),
        attachment: Type.Optional(Type.String({ description: "Base64-encoded binary content" })),
      }),
      async execute(
        _id: string,
        params: { theme_id: string; key: string; value?: string; attachment?: string },
      ) {
        const { accessToken, shop } = await creds();
        const result = await client.updateThemeAsset(accessToken, shop, {
          theme_id: params.theme_id,
          key: params.key,
          value: params.value,
          attachment: params.attachment,
        });
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_get_theme_settings",
      label: "Shopify Get Theme Settings",
      description: "Retrieve the settings_data.json configuration for a theme.",
      parameters: Type.Object({
        theme_id: Type.String({ description: "Theme ID" }),
      }),
      async execute(_id: string, params: { theme_id: string }) {
        const { accessToken, shop } = await creds();
        const result = await client.getThemeSettings(accessToken, shop, params.theme_id);
        return textResult(JSON.stringify(result, null, 2));
      },
    },
    {
      name: "shopify_update_theme_settings",
      label: "Shopify Update Theme Settings",
      description: "Update the settings_data.json configuration for a theme.",
      parameters: Type.Object({
        theme_id: Type.String({ description: "Theme ID" }),
        settings: Type.Any({ description: "Settings object to write to settings_data.json" }),
      }),
      async execute(_id: string, params: { theme_id: string; settings: Record<string, any> }) {
        const { accessToken, shop } = await creds();
        const result = await client.updateThemeSettings(
          accessToken,
          shop,
          params.theme_id,
          params.settings,
        );
        return textResult(JSON.stringify(result, null, 2));
      },
    },
  ];
}
