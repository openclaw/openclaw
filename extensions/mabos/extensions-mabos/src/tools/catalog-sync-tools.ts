/**
 * Catalog Sync Tools — Shopify product catalog sync & local query
 *
 * Pulls full product data from Shopify GraphQL API into workspace JSON
 * for agent-accessible catalog queries without repeated API calls.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir, httpRequest } from "./common.js";

async function readJson(p: string) {
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}
async function writeJson(p: string, d: unknown) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(d, null, 2), "utf-8");
}

// ── Shopify credential loader ──────────────────────────────────────────

interface ShopifyCreds {
  store: string;
  accessToken: string;
}

async function loadShopifyCreds(ws: string): Promise<ShopifyCreds | null> {
  for (const p of [
    join(ws, "businesses", "vividwalls", "integrations.json"),
    join(ws, "integrations.json"),
  ]) {
    const data = await readJson(p);
    const entry = (data?.integrations || []).find(
      (i: any) => (i.id === "shopify-main" || i.id === "shopify-admin") && i.enabled,
    );
    if (entry?.api_key) {
      const domain = entry.metadata?.domain || entry.metadata?.store || "";
      const store = domain.replace(".myshopify.com", "");
      if (store) return { store, accessToken: entry.api_key };
    }
  }
  // Fallback to env vars
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (store && token) return { store, accessToken: token };
  return null;
}

// ── Shopify GraphQL helper ─────────────────────────────────────────────

const SHOPIFY_API_VERSION = "2024-04";

async function shopifyGql(creds: ShopifyCreds, query: string, variables?: Record<string, unknown>) {
  const url = `https://${creds.store}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  return httpRequest(
    url,
    "POST",
    {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": creds.accessToken,
    },
    { query, variables },
  );
}

// ── GraphQL Queries ────────────────────────────────────────────────────

const PRODUCTS_QUERY = `
query($first: Int!, $after: String, $query: String) {
  products(first: $first, after: $after, query: $query) {
    edges {
      cursor
      node {
        id
        title
        handle
        productType
        tags
        status
        createdAt
        updatedAt
        images(first: 10) {
          edges { node { url } }
        }
        variants(first: 250) {
          edges {
            node {
              id
              title
              sku
              price
              availableForSale
              inventoryQuantity
            }
          }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

function mapProduct(node: any) {
  return {
    shopify_gid: node.id,
    title: node.title,
    handle: node.handle,
    product_type: node.productType || "",
    tags: node.tags || [],
    status: node.status?.toLowerCase() || "active",
    images: (node.images?.edges || []).map((e: any) => ({ src: e.node.url })),
    variants: (node.variants?.edges || []).map((e: any) => ({
      id: e.node.id,
      title: e.node.title,
      sku: e.node.sku || "",
      price: e.node.price,
      available: e.node.availableForSale,
      inventory_qty: e.node.inventoryQuantity ?? null,
    })),
    created_at: node.createdAt,
    updated_at: node.updatedAt,
  };
}

// ── Parameter Schemas ──────────────────────────────────────────────────

const CatalogSyncParams = Type.Object({
  mode: Type.Union([Type.Literal("full"), Type.Literal("incremental")], {
    description: "full = re-sync everything; incremental = only products updated since last sync",
  }),
});

const CatalogQueryParams = Type.Object({
  filter: Type.Optional(
    Type.Object({
      tags: Type.Optional(
        Type.Array(Type.String(), { description: "Filter by any of these tags" }),
      ),
      product_type: Type.Optional(Type.String({ description: "Filter by product type" })),
      status: Type.Optional(
        Type.String({ description: "Filter by status (active/draft/archived)" }),
      ),
      available_only: Type.Optional(
        Type.Boolean({ description: "Only products with available variants" }),
      ),
    }),
  ),
  limit: Type.Optional(Type.Number({ description: "Max products to return (default 50)" })),
});

// ── Tool Factory ───────────────────────────────────────────────────────

export function createCatalogSyncTools(api: OpenClawPluginApi): AnyAgentTool[] {
  const ws = resolveWorkspaceDir(api);
  const bizDir = join(ws, "businesses", "vividwalls");
  const catalogPath = join(bizDir, "product-catalog-live.json");

  return [
    {
      name: "product_catalog_sync",
      label: "Sync Product Catalog",
      description:
        "Pull full product data from Shopify into local workspace JSON. Use mode=full for a complete refresh or mode=incremental to only fetch recently updated products.",
      parameters: CatalogSyncParams,
      async execute(_id: string, params: Static<typeof CatalogSyncParams>) {
        const creds = await loadShopifyCreds(ws);
        if (!creds)
          return textResult(
            "**Error:** Shopify credentials not found. Set SHOPIFY_STORE + SHOPIFY_ACCESS_TOKEN env vars or add shopify-admin to integrations.json.",
          );

        const existing = await readJson(catalogPath);
        let queryFilter: string | undefined;

        if (params.mode === "incremental" && existing?.synced_at) {
          queryFilter = `updated_at:>'${existing.synced_at}'`;
        }

        const allProducts: any[] = [];
        let cursor: string | undefined;

        // Paginate through all products
        while (true) {
          const resp = await shopifyGql(creds, PRODUCTS_QUERY, {
            first: 50,
            after: cursor || null,
            query: queryFilter || null,
          });

          if (resp.status !== 200 || resp.data?.errors) {
            const errMsg = resp.data?.errors?.[0]?.message || JSON.stringify(resp.data);
            return textResult(`**Shopify API error** (${resp.status}): ${errMsg}`);
          }

          const edges = resp.data?.data?.products?.edges || [];
          for (const edge of edges) {
            allProducts.push(mapProduct(edge.node));
          }

          const pageInfo = resp.data?.data?.products?.pageInfo;
          if (!pageInfo?.hasNextPage) break;
          cursor = pageInfo.endCursor;
        }

        // Merge or replace
        let finalProducts: any[];
        if (params.mode === "incremental" && existing?.products) {
          const updatedIds = new Set(allProducts.map((p: any) => p.shopify_gid));
          finalProducts = [
            ...existing.products.filter((p: any) => !updatedIds.has(p.shopify_gid)),
            ...allProducts,
          ];
        } else {
          finalProducts = allProducts;
        }

        const catalog = {
          synced_at: new Date().toISOString(),
          product_count: finalProducts.length,
          products: finalProducts,
        };

        await writeJson(catalogPath, catalog);

        return textResult(
          `## Catalog Sync Complete\n\n` +
            `- **Mode:** ${params.mode}\n` +
            `- **Products synced:** ${allProducts.length}\n` +
            `- **Total catalog size:** ${finalProducts.length}\n` +
            `- **Synced at:** ${catalog.synced_at}`,
        );
      },
    },

    {
      name: "product_catalog_query",
      label: "Query Product Catalog",
      description:
        "Query the locally synced product catalog with filters. Returns matching products from the last Shopify sync.",
      parameters: CatalogQueryParams,
      async execute(_id: string, params: Static<typeof CatalogQueryParams>) {
        const catalog = await readJson(catalogPath);
        if (!catalog?.products?.length) {
          return textResult(
            "**No catalog data.** Run `product_catalog_sync` with mode=full first.",
          );
        }

        let results = [...catalog.products];
        const f = params.filter;

        if (f?.tags?.length) {
          results = results.filter((p: any) =>
            f.tags!.some((t) =>
              p.tags.map((pt: string) => pt.toLowerCase()).includes(t.toLowerCase()),
            ),
          );
        }
        if (f?.product_type) {
          results = results.filter(
            (p: any) => p.product_type.toLowerCase() === f.product_type!.toLowerCase(),
          );
        }
        if (f?.status) {
          results = results.filter((p: any) => p.status === f.status!.toLowerCase());
        }
        if (f?.available_only) {
          results = results.filter((p: any) => p.variants.some((v: any) => v.available));
        }

        const limit = params.limit || 50;
        results = results.slice(0, limit);

        if (!results.length) {
          return textResult("No products match the given filters.");
        }

        const rows = results.map((p: any) => {
          const firstVariant = p.variants[0];
          const totalQty = p.variants.reduce((s: number, v: any) => s + (v.inventory_qty ?? 0), 0);
          return `| ${p.title} | ${firstVariant?.sku || "—"} | $${firstVariant?.price || "—"} | ${totalQty} | ${p.tags.join(", ")} |`;
        });

        return textResult(
          `## Catalog Query Results (${results.length}/${catalog.product_count})\n\n` +
            `Last synced: ${catalog.synced_at}\n\n` +
            `| Title | SKU | Price | Stock | Tags |\n|-------|-----|-------|-------|------|\n` +
            rows.join("\n"),
        );
      },
    },
  ];
}
