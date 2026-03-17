/**
 * LE Inventory Tools — Limited Edition stock tracking and scarcity alerts
 *
 * Syncs inventory from Shopify, tracks LE edition stock levels,
 * and fires scarcity threshold alerts via SendGrid.
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
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (store && token) return { store, accessToken: token };
  return null;
}

// ── SendGrid credential loader ─────────────────────────────────────────

interface SendGridCreds {
  apiKey: string;
  fromEmail: string;
  fromName: string;
}

async function loadSendGridCreds(ws: string): Promise<SendGridCreds | null> {
  for (const p of [
    join(ws, "businesses", "vividwalls", "integrations.json"),
    join(ws, "integrations.json"),
  ]) {
    const data = await readJson(p);
    const entry = (data?.integrations || []).find(
      (i: any) => i.id === "sendgrid-main" && i.enabled,
    );
    if (entry?.api_key) {
      return {
        apiKey: entry.api_key,
        fromEmail: entry.metadata?.from_email || "noreply@vividwalls.co",
        fromName: entry.metadata?.from_name || "VividWalls",
      };
    }
  }
  return null;
}

// ── Shopify GraphQL ────────────────────────────────────────────────────

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

const INVENTORY_QUERY = `
query($first: Int!, $after: String, $query: String) {
  products(first: $first, after: $after, query: $query) {
    edges {
      cursor
      node {
        id
        title
        handle
        variants(first: 250) {
          edges {
            node {
              id
              title
              sku
              price
              inventoryQuantity
            }
          }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

// ── Parameter Schemas ──────────────────────────────────────────────────

const InventoryParams = Type.Object({
  action: Type.Union([Type.Literal("sync"), Type.Literal("status"), Type.Literal("init_edition")], {
    description:
      "sync = pull from Shopify; status = show current stock; init_edition = set up tracking",
  }),
  edition_id: Type.Optional(
    Type.String({ description: "Edition identifier (e.g. chromatic-visions-2026)" }),
  ),
  edition_size: Type.Optional(
    Type.Number({ description: "Total edition size (for init_edition)" }),
  ),
  shopify_tag: Type.Optional(
    Type.String({ description: "Shopify tag to identify LE products (for init_edition)" }),
  ),
});

const ScarcityCheckParams = Type.Object({
  edition_id: Type.String({ description: "Edition identifier" }),
  thresholds: Type.Optional(
    Type.Array(Type.Number(), {
      description: "Percent-sold thresholds to check (default: [75, 50, 25, 10])",
    }),
  ),
});

// ── Tool Factory ───────────────────────────────────────────────────────

export function createLeInventoryTools(api: OpenClawPluginApi): AnyAgentTool[] {
  const ws = resolveWorkspaceDir(api);
  const bizDir = join(ws, "businesses", "vividwalls");
  const inventoryPath = join(bizDir, "le-inventory-status.json");

  async function loadInventory() {
    return (
      (await readJson(inventoryPath)) || {
        editions: {},
        last_synced_at: null,
        thresholds_fired: {},
      }
    );
  }

  return [
    // ── le_inventory ───────────────────────────────────────────────
    {
      name: "le_inventory",
      label: "LE Inventory Tracking",
      description:
        "Track Limited Edition stock levels. init_edition to set up tracking, sync to pull current inventory from Shopify, status to view stock levels.",
      parameters: InventoryParams,
      async execute(_id: string, params: Static<typeof InventoryParams>) {
        const inv = await loadInventory();

        switch (params.action) {
          case "init_edition": {
            if (!params.edition_id || !params.edition_size || !params.shopify_tag) {
              return textResult(
                "**Error:** edition_id, edition_size, and shopify_tag are all required for init_edition.",
              );
            }
            inv.editions[params.edition_id] = {
              edition_size: params.edition_size,
              shopify_tag: params.shopify_tag,
              products: [],
              total_remaining: params.edition_size,
              total_sold: 0,
              percent_sold: 0,
              initialized_at: new Date().toISOString(),
            };
            inv.thresholds_fired[params.edition_id] = [];
            await writeJson(inventoryPath, inv);
            return textResult(
              `## Edition Initialized\n\n` +
                `- **Edition:** ${params.edition_id}\n` +
                `- **Size:** ${params.edition_size} pieces\n` +
                `- **Shopify tag:** ${params.shopify_tag}\n\n` +
                `Run \`le_inventory action=sync edition_id=${params.edition_id}\` to pull current stock.`,
            );
          }

          case "sync": {
            const creds = await loadShopifyCreds(ws);
            if (!creds) return textResult("**Error:** Shopify credentials not found.");

            // Sync all editions or a specific one
            const editionsToSync = params.edition_id
              ? { [params.edition_id]: inv.editions[params.edition_id] }
              : inv.editions;

            const results: string[] = [];

            for (const [edId, edData] of Object.entries(editionsToSync)) {
              if (!edData) {
                results.push(`- **${edId}:** not initialized, skipping`);
                continue;
              }

              const ed = edData as any;
              const tagQuery = `tag:${ed.shopify_tag}`;
              const products: any[] = [];
              let cursor: string | undefined;

              while (true) {
                const resp = await shopifyGql(creds, INVENTORY_QUERY, {
                  first: 50,
                  after: cursor || null,
                  query: tagQuery,
                });

                if (resp.status !== 200 || resp.data?.errors) {
                  results.push(
                    `- **${edId}:** Shopify error: ${resp.data?.errors?.[0]?.message || resp.status}`,
                  );
                  break;
                }

                const edges = resp.data?.data?.products?.edges || [];
                for (const edge of edges) {
                  const node = edge.node;
                  const variants = (node.variants?.edges || []).map((ve: any) => ({
                    id: ve.node.id,
                    title: ve.node.title,
                    sku: ve.node.sku || "",
                    price: ve.node.price,
                    inventory_qty: ve.node.inventoryQuantity ?? 0,
                  }));
                  const totalQty = variants.reduce((s: number, v: any) => s + v.inventory_qty, 0);
                  products.push({
                    shopify_gid: node.id,
                    title: node.title,
                    handle: node.handle,
                    variants,
                    total_remaining: totalQty,
                  });
                }

                const pageInfo = resp.data?.data?.products?.pageInfo;
                if (!pageInfo?.hasNextPage) break;
                cursor = pageInfo.endCursor;
              }

              const totalRemaining = products.reduce(
                (s: number, p: any) => s + p.total_remaining,
                0,
              );
              const totalSold = ed.edition_size - totalRemaining;
              const percentSold =
                ed.edition_size > 0 ? Math.round((totalSold / ed.edition_size) * 100) : 0;

              ed.products = products;
              ed.total_remaining = totalRemaining;
              ed.total_sold = totalSold;
              ed.percent_sold = percentSold;

              results.push(
                `- **${edId}:** ${products.length} products, ${totalRemaining} remaining (${percentSold}% sold)`,
              );
            }

            inv.last_synced_at = new Date().toISOString();
            await writeJson(inventoryPath, inv);

            return textResult(
              `## Inventory Sync Complete\n\n${results.join("\n")}\n\nSynced at: ${inv.last_synced_at}`,
            );
          }

          case "status": {
            const editionsToShow = params.edition_id
              ? { [params.edition_id]: inv.editions[params.edition_id] }
              : inv.editions;

            if (!Object.keys(editionsToShow).length) {
              return textResult(
                "No LE editions are being tracked. Use `le_inventory action=init_edition` to set one up.",
              );
            }

            const sections: string[] = [];
            for (const [edId, edData] of Object.entries(editionsToShow)) {
              if (!edData) continue;
              const ed = edData as any;
              const productRows = (ed.products || []).map(
                (p: any) =>
                  `| ${p.title} | ${p.variants?.map((v: any) => v.sku).join(", ") || "—"} | ${p.total_remaining} |`,
              );
              sections.push(
                `### ${edId}\n\n` +
                  `- **Edition size:** ${ed.edition_size}\n` +
                  `- **Remaining:** ${ed.total_remaining}\n` +
                  `- **Sold:** ${ed.total_sold} (${ed.percent_sold}%)\n` +
                  `- **Thresholds fired:** ${(inv.thresholds_fired[edId] || []).join(", ") || "none"}\n\n` +
                  (productRows.length
                    ? `| Product | SKUs | Remaining |\n|---------|------|-----------|\n${productRows.join("\n")}`
                    : "No products synced yet."),
              );
            }

            return textResult(
              `## LE Inventory Status\n\nLast synced: ${inv.last_synced_at || "never"}\n\n${sections.join("\n\n")}`,
            );
          }
        }
      },
    },

    // ── le_scarcity_check ──────────────────────────────────────────
    {
      name: "le_scarcity_check",
      label: "LE Scarcity Check",
      description:
        "Evaluate scarcity thresholds for an LE edition and trigger alerts when new thresholds are crossed. Sends scarcity emails to waitlist via SendGrid.",
      parameters: ScarcityCheckParams,
      async execute(_id: string, params: Static<typeof ScarcityCheckParams>) {
        const inv = await loadInventory();
        const ed = inv.editions[params.edition_id] as any;
        if (!ed) {
          return textResult(
            `**Error:** Edition ${params.edition_id} not found. Run le_inventory action=init_edition first.`,
          );
        }

        const thresholds = params.thresholds || [75, 50, 25, 10];
        const fired = inv.thresholds_fired[params.edition_id] || [];
        const newlyFired: number[] = [];
        const alerts: string[] = [];

        for (const threshold of thresholds.sort((a, b) => a - b)) {
          if (ed.percent_sold >= threshold && !fired.includes(threshold)) {
            newlyFired.push(threshold);
            alerts.push(
              `${threshold}% sold threshold crossed (currently ${ed.percent_sold}% sold)`,
            );
          }
        }

        if (newlyFired.length) {
          // Send scarcity alerts to waitlist
          const sgCreds = await loadSendGridCreds(ws);
          const waitlistState = await readJson(join(bizDir, "le-waitlist-state.json"));
          const waitlistEdition = waitlistState?.editions?.[params.edition_id];

          if (sgCreds && waitlistEdition?.waitlist?.length) {
            const recipients = waitlistEdition.waitlist.map((w: any) => w.email);
            const percentRemaining = 100 - ed.percent_sold;
            const subject = `Only ${percentRemaining}% left: ${params.edition_id} Limited Edition`;
            const html = `<h2>Almost Gone</h2><p>The <strong>${params.edition_id}</strong> collection is <strong>${ed.percent_sold}% sold</strong>. Only ${ed.total_remaining} pieces remain out of ${ed.edition_size}.</p><p><a href="https://vividwalls.co/collections/${params.edition_id}">Secure yours now →</a></p><p>— The VividWalls Team</p>`;

            // Send batch
            const batchSize = 1000;
            for (let i = 0; i < recipients.length; i += batchSize) {
              const batch = recipients.slice(i, i + batchSize);
              await httpRequest(
                "https://api.sendgrid.com/v3/mail/send",
                "POST",
                {
                  Authorization: `Bearer ${sgCreds.apiKey}`,
                  "Content-Type": "application/json",
                },
                {
                  personalizations: batch.map((email: string) => ({ to: [{ email }] })),
                  from: { email: sgCreds.fromEmail, name: sgCreds.fromName },
                  subject,
                  content: [{ type: "text/html", value: html }],
                },
              );
            }
            alerts.push(`Scarcity email sent to ${recipients.length} waitlist subscribers`);
          }

          // Record thresholds as fired
          inv.thresholds_fired[params.edition_id] = [...fired, ...newlyFired];
          await writeJson(inventoryPath, inv);

          // Write snapshot for CMO context
          await writeJson(join(bizDir, "le-scarcity-status.json"), {
            edition_id: params.edition_id,
            percent_sold: ed.percent_sold,
            total_remaining: ed.total_remaining,
            total_sold: ed.total_sold,
            edition_size: ed.edition_size,
            thresholds_fired: inv.thresholds_fired[params.edition_id],
            checked_at: new Date().toISOString(),
          });
        }

        return textResult(
          `## Scarcity Check: ${params.edition_id}\n\n` +
            `- **Stock:** ${ed.total_remaining}/${ed.edition_size} remaining (${ed.percent_sold}% sold)\n` +
            `- **Thresholds checked:** ${thresholds.join(", ")}%\n` +
            `- **Previously fired:** ${fired.join(", ") || "none"}\n` +
            (newlyFired.length
              ? `- **New alerts fired:** ${newlyFired.join(", ")}%\n\n${alerts.map((a) => `  - ${a}`).join("\n")}`
              : `- **No new thresholds crossed.**`),
        );
      },
    },
  ];
}
