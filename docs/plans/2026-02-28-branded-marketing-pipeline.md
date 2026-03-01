# Branded Marketing Pipeline — Templates, Telegram Approval, Notion Integration

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enforce consistent VividWalls branding on all social posts/ads, pull product images from Shopify, require Telegram DM approval before publishing or launching campaigns, and wire Notion as the source-of-truth for content calendar, ad campaigns, blog content, and creatives.

**Architecture:** Three new tool modules added to the MABOS extension: (1) `brand-template-tools.ts` — brand config + post template rendering, (2) `notion-tools.ts` — Notion CRUD for marketing databases, (3) `approval-gate-tools.ts` — Telegram DM approval flow with inline keyboard callbacks. The existing `marketing-tools.ts` is modified to call the approval gate before publishing and to pull Shopify product images. A new `brand.json` config file defines VividWalls brand constants.

**Tech Stack:** TypeScript, Node `fetch`, Telegram Bot API (inline keyboards + `answerCallbackQuery`), Notion API v2022-06-28, Shopify Admin REST API, OpenClaw plugin-sdk (`AnyAgentTool`).

---

## Notion Database IDs (from discovery)

| Database                       | ID                                     | Key Properties                                                                |
| ------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------- |
| Content Calendar               | `30d859d1-bdd3-819b-bab9-c2ddb20f325b` | Status, Platform, Publish Date, Content Type, Media URL, Hashtags, Link URL   |
| VividWalls Marketing Campaigns | `e1b57d5a-35c4-499c-a68b-7e44306d395b` | Campaign Name, Platform, Budget, Status, Target Segment, Landing Page URL     |
| Ad Sets                        | `85e68ef2-97a0-4199-943f-99fc8d6a8a1d` | Platform, Campaign, Ad Budget, CTR%, CPC, Status, Launch Date, Creative Theme |
| Blog Content                   | `05717c82-1989-4a22-96d8-a314bf00278a` | Title, Status, Keywords, Publish On Date, Channels, Featured Image            |
| Creatives                      | `2b3ce177-ea75-4e63-ac7e-d46d08986408` | Artwork, Image Url, Style, Tags, Keywords, Orientation, Mood                  |
| Shopify Product :: Artwork     | `180859d1-bdd3-80df-b9a3-ee04188e9746` | Published, Variant Price, Image Alt Text, Variant Image                       |
| Primary Palette                | `7c79dab6-fe97-489f-8e69-130ccd6dec65` | Name, Hex, RGB, SASS Variable                                                 |
| Secondary Palette              | `e329f738-e981-40fb-9503-98e97f28ec33` | Name, Hex, RGB, SASS Variable                                                 |

## Env Vars to Add

```env
# Telegram Approval Bot
TELEGRAM_BOT_TOKEN=<create via @BotFather>
TELEGRAM_OWNER_CHAT_ID=<your personal chat ID>

# Notion Database IDs
NOTION_CONTENT_CALENDAR_DB=30d859d1-bdd3-819b-bab9-c2ddb20f325b
NOTION_CAMPAIGNS_DB=e1b57d5a-35c4-499c-a68b-7e44306d395b
NOTION_ADSETS_DB=85e68ef2-97a0-4199-943f-99fc8d6a8a1d
NOTION_BLOG_DB=05717c82-1989-4a22-96d8-a314bf00278a
NOTION_CREATIVES_DB=2b3ce177-ea75-4e63-ac7e-d46d08986408
```

---

## Task 1: Create VividWalls Brand Config

**Files:**

- Create: `extensions/mabos/src/tools/brand-config.ts`

**Step 1: Write `brand-config.ts`**

```typescript
/**
 * VividWalls Brand Configuration — single source of truth for
 * branding applied to all social posts, ads, and marketing content.
 */

export const BRAND = {
  name: "VividWalls",
  tagline: "Transform your space with art that speaks to your soul.",
  website: "https://vividwalls.co",
  productUrlPattern: "https://vividwalls.co/products/{handle}",
  logo_url: "https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vividwalls-logo.png",

  hashtags: {
    always: ["#VividWalls", "#WallArt", "#HomeDecor"],
    art: ["#ContemporaryArt", "#ArtPrint", "#AbstractArt", "#ModernHome"],
    interiorDesign: ["#InteriorDesign", "#RoomStyling", "#ArtForHome"],
    lifestyle: ["#CozyVibes", "#StylishSpaces", "#ArtMeetsHome"],
  },

  palette: {
    primary: "#0061FF", // Acme Blue
    secondary: "#1A1A2E", // Dark navy
    accent: "#E94560", // Crimson accent
    background: "#FFFFFF",
    text: "#1A1A2E",
  },

  typography: {
    heading: "Playfair Display",
    body: "Inter",
  },

  templates: {
    /** Standard social post caption */
    socialPost: (product: { title: string; handle: string; price: string; description?: string }) =>
      `${product.description || `Discover "${product.title}" — premium wall art that transforms any space.`}\n\nStarting at $${product.price}\nShop now: https://vividwalls.co/products/${product.handle}\n\n${["#VividWalls", "#WallArt", "#HomeDecor", "#InteriorDesign", "#ArtPrint", "#ModernHome"].join(" ")}`,

    /** Ad copy with CTA */
    adCopy: (product: { title: string; handle: string; price: string }) =>
      `Transform your space with "${product.title}" by VividWalls. Premium wall art starting at $${product.price}. Shop now!`,

    /** Instagram caption (shorter, hashtag-heavy) */
    instagramCaption: (product: {
      title: string;
      handle: string;
      price: string;
      description?: string;
    }) =>
      `${product.description || `"${product.title}" — art that speaks to your soul.`}\n\nAvailable at $${product.price}. Link in bio or shop: vividwalls.co/products/${product.handle}\n\n${["#VividWalls", "#WallArt", "#ContemporaryArt", "#HomeDecor", "#InteriorDesign", "#ArtPrint", "#AbstractArt", "#ModernHome", "#RoomStyling", "#ArtForHome", "#CozyVibes", "#StylishSpaces"].join(" ")}`,
  },
} as const;

/** Fetch a product from Shopify by handle and return image + metadata */
export async function fetchShopifyProduct(handle: string): Promise<{
  id: number;
  title: string;
  handle: string;
  price: string;
  image_url: string;
  images: string[];
  description: string;
} | null> {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!store || !token) return null;

  const resp = await fetch(
    `https://${store}/admin/api/2024-01/products.json?handle=${handle}&fields=id,title,handle,body_html,variants,images`,
    { headers: { "X-Shopify-Access-Token": token } },
  );
  if (!resp.ok) return null;
  const data = (await resp.json()) as any;
  const product = data.products?.[0];
  if (!product) return null;

  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    price: product.variants?.[0]?.price || "50.92",
    image_url: product.images?.[0]?.src || "",
    images: (product.images || []).map((i: any) => i.src),
    description: (product.body_html || "").replace(/<[^>]+>/g, "").slice(0, 200),
  };
}

/** List all Shopify products (for browsing the artwork catalog) */
export async function listShopifyProducts(limit = 50): Promise<
  Array<{
    id: number;
    title: string;
    handle: string;
    price: string;
    image_url: string;
  }>
> {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!store || !token) return [];

  const resp = await fetch(
    `https://${store}/admin/api/2024-01/products.json?limit=${limit}&fields=id,title,handle,variants,images`,
    { headers: { "X-Shopify-Access-Token": token } },
  );
  if (!resp.ok) return [];
  const data = (await resp.json()) as any;
  return (data.products || []).map((p: any) => ({
    id: p.id,
    title: p.title,
    handle: p.handle,
    price: p.variants?.[0]?.price || "50.92",
    image_url: p.images?.[0]?.src || "",
  }));
}
```

**Step 2: Commit**

```bash
git add extensions/mabos/src/tools/brand-config.ts
git commit -m "feat(mabos): add VividWalls brand config + Shopify product helpers"
```

---

## Task 2: Create Telegram Approval Gate

**Files:**

- Create: `extensions/mabos/src/tools/approval-gate.ts`

This module sends a Telegram DM with an inline keyboard (Approve / Reject) and polls for the callback response.

**Step 1: Write `approval-gate.ts`**

```typescript
/**
 * Telegram Approval Gate — sends approval requests to the owner's
 * Telegram DM with inline keyboard buttons. Blocks until approved/rejected
 * or times out after a configurable period.
 */

const TG_API = "https://api.telegram.org/bot";

function tgUrl(method: string): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  return `${TG_API}${token}/${method}`;
}

function ownerChatId(): string {
  const id = process.env.TELEGRAM_OWNER_CHAT_ID;
  if (!id) throw new Error("TELEGRAM_OWNER_CHAT_ID not set");
  return id;
}

export type ApprovalRequest = {
  type: "post" | "campaign" | "ad_set";
  summary: string; // Markdown-formatted summary shown in TG
  details: string; // Full details (platform, budget, targeting, etc.)
  preview_url?: string; // Image preview URL if available
};

export type ApprovalResult = {
  approved: boolean;
  decided_by: string;
  decided_at: string;
  message_id?: number;
};

/** Send an approval request to the owner's Telegram DM */
export async function requestApproval(req: ApprovalRequest): Promise<ApprovalResult> {
  const chatId = ownerChatId();
  const callbackId = `approval_${Date.now().toString(36)}`;

  const text = [
    `🔔 *Approval Required: ${req.type.toUpperCase()}*\n`,
    req.summary,
    `\n---\n${req.details}`,
  ].join("\n");

  const body: any = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `${callbackId}:approve` },
          { text: "❌ Reject", callback_data: `${callbackId}:reject` },
        ],
      ],
    },
  };

  // If there's a preview image, send photo first, then buttons
  if (req.preview_url) {
    await fetch(tgUrl("sendPhoto"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: req.preview_url,
        caption: `Preview: ${req.type}`,
      }),
    });
  }

  const sendResp = await fetch(tgUrl("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const sendData = (await sendResp.json()) as any;
  const messageId = sendData.result?.message_id;

  // Poll for callback using getUpdates with a filter
  const timeoutMs = 5 * 60 * 1000; // 5 minute timeout
  const pollIntervalMs = 3000;
  const deadline = Date.now() + timeoutMs;
  let lastUpdateId = 0;

  while (Date.now() < deadline) {
    const updatesResp = await fetch(tgUrl("getUpdates"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        offset: lastUpdateId + 1,
        timeout: 10,
        allowed_updates: ["callback_query"],
      }),
    });
    const updatesData = (await updatesResp.json()) as any;

    for (const update of updatesData.result || []) {
      lastUpdateId = update.update_id;
      const cb = update.callback_query;
      if (cb?.data?.startsWith(callbackId)) {
        const action = cb.data.split(":")[1];
        // Answer the callback to remove the loading spinner
        await fetch(tgUrl("answerCallbackQuery"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callback_query_id: cb.id,
            text: action === "approve" ? "Approved!" : "Rejected.",
          }),
        });
        // Edit the message to show the decision
        await fetch(tgUrl("editMessageText"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: `${text}\n\n${action === "approve" ? "✅ APPROVED" : "❌ REJECTED"} by owner at ${new Date().toISOString()}`,
            parse_mode: "Markdown",
          }),
        });
        return {
          approved: action === "approve",
          decided_by: `${cb.from?.first_name || "Owner"} (Telegram)`,
          decided_at: new Date().toISOString(),
          message_id: messageId,
        };
      }
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  // Timeout — edit message to show expiry
  await fetch(tgUrl("editMessageText"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: `${text}\n\n⏰ TIMED OUT — no response within 5 minutes.`,
      parse_mode: "Markdown",
    }),
  });

  return {
    approved: false,
    decided_by: "system (timeout)",
    decided_at: new Date().toISOString(),
    message_id: messageId,
  };
}

/** Send a simple notification (no approval needed) */
export async function notifyOwner(message: string): Promise<void> {
  await fetch(tgUrl("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: ownerChatId(),
      text: message,
      parse_mode: "Markdown",
    }),
  });
}
```

**Step 2: Commit**

```bash
git add extensions/mabos/src/tools/approval-gate.ts
git commit -m "feat(mabos): add Telegram approval gate with inline keyboard polling"
```

---

## Task 3: Create Notion Integration Tools

**Files:**

- Create: `extensions/mabos/src/tools/notion-tools.ts`

**Step 1: Write `notion-tools.ts`**

This module provides tools for the agent to query, create, and update records in the Notion marketing databases. It follows the same factory pattern as other MABOS tool modules.

```typescript
/**
 * Notion Tools — Content calendar, campaigns, ad sets, blog, creatives
 *
 * Provides CRUD access to VividWalls marketing Notion databases.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "./common.js";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function notionHeaders(): Record<string, string> {
  const key = process.env.NOTION_API_KEY;
  if (!key) throw new Error("NOTION_API_KEY not set");
  return {
    Authorization: `Bearer ${key}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

function dbId(name: string): string {
  const map: Record<string, string | undefined> = {
    content_calendar: process.env.NOTION_CONTENT_CALENDAR_DB,
    campaigns: process.env.NOTION_CAMPAIGNS_DB,
    ad_sets: process.env.NOTION_ADSETS_DB,
    blog: process.env.NOTION_BLOG_DB,
    creatives: process.env.NOTION_CREATIVES_DB,
  };
  const id = map[name];
  if (!id) throw new Error(`Notion DB ID not set for: ${name}. Set NOTION_*_DB env vars.`);
  return id;
}

async function notionFetch(path: string, method = "GET", body?: unknown) {
  const resp = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: notionHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  return resp.json() as Promise<any>;
}

// Helper to extract plain text from Notion rich_text array
function plainText(richText: any[]): string {
  return (richText || []).map((t: any) => t.plain_text || "").join("");
}

// --- Schemas ---
const NotionQueryParams = Type.Object({
  database: Type.Union(
    [
      Type.Literal("content_calendar"),
      Type.Literal("campaigns"),
      Type.Literal("ad_sets"),
      Type.Literal("blog"),
      Type.Literal("creatives"),
    ],
    { description: "Which Notion database to query" },
  ),
  filter: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Notion filter object (see Notion API docs). Omit to return all.",
    }),
  ),
  sorts: Type.Optional(
    Type.Array(
      Type.Object({
        property: Type.String(),
        direction: Type.Union([Type.Literal("ascending"), Type.Literal("descending")]),
      }),
    ),
  ),
  page_size: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
});

const NotionCreateParams = Type.Object({
  database: Type.Union([
    Type.Literal("content_calendar"),
    Type.Literal("campaigns"),
    Type.Literal("ad_sets"),
    Type.Literal("blog"),
    Type.Literal("creatives"),
  ]),
  properties: Type.Record(Type.String(), Type.Unknown(), {
    description: "Notion page properties object matching the database schema",
  }),
});

const NotionUpdateParams = Type.Object({
  page_id: Type.String({ description: "Notion page ID to update" }),
  properties: Type.Record(Type.String(), Type.Unknown(), {
    description: "Properties to update",
  }),
});

const NotionGetParams = Type.Object({
  page_id: Type.String({ description: "Notion page ID" }),
});

export function createNotionTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "notion_query",
      label: "Query Notion Database",
      description:
        "Query a VividWalls Notion marketing database (content_calendar, campaigns, ad_sets, blog, creatives). Returns matching pages with properties.",
      parameters: NotionQueryParams,
      async execute(_id: string, params: Static<typeof NotionQueryParams>) {
        const body: any = { page_size: params.page_size || 20 };
        if (params.filter) body.filter = params.filter;
        if (params.sorts) body.sorts = params.sorts;

        const data = await notionFetch(`/databases/${dbId(params.database)}/query`, "POST", body);
        if (data.object === "error") {
          return textResult(`❌ Notion query error: ${data.message}`);
        }

        const rows = (data.results || []).map((page: any) => {
          const props = page.properties || {};
          const summary: Record<string, string> = { id: page.id };
          for (const [key, val] of Object.entries(props) as [string, any][]) {
            if (val.type === "title") summary[key] = plainText(val.title);
            else if (val.type === "rich_text") summary[key] = plainText(val.rich_text);
            else if (val.type === "select") summary[key] = val.select?.name || "";
            else if (val.type === "multi_select")
              summary[key] = val.multi_select?.map((s: any) => s.name).join(", ") || "";
            else if (val.type === "date") summary[key] = val.date?.start || "";
            else if (val.type === "number") summary[key] = String(val.number ?? "");
            else if (val.type === "url") summary[key] = val.url || "";
            else if (val.type === "checkbox") summary[key] = val.checkbox ? "Yes" : "No";
            else if (val.type === "status") summary[key] = val.status?.name || "";
          }
          return summary;
        });

        return textResult(
          `## Notion: ${params.database} (${rows.length} results)\n\n\`\`\`json\n${JSON.stringify(rows, null, 2)}\n\`\`\``,
        );
      },
    },

    {
      name: "notion_create",
      label: "Create Notion Page",
      description:
        "Create a new page in a VividWalls Notion marketing database. Properties must match the database schema.",
      parameters: NotionCreateParams,
      async execute(_id: string, params: Static<typeof NotionCreateParams>) {
        const data = await notionFetch("/pages", "POST", {
          parent: { database_id: dbId(params.database) },
          properties: params.properties,
        });
        if (data.object === "error") {
          return textResult(`❌ Notion create error: ${data.message}`);
        }
        return textResult(
          `✅ Created Notion page in ${params.database}: ${data.id}\nURL: ${data.url}`,
        );
      },
    },

    {
      name: "notion_update",
      label: "Update Notion Page",
      description: "Update properties on an existing Notion page by page ID.",
      parameters: NotionUpdateParams,
      async execute(_id: string, params: Static<typeof NotionUpdateParams>) {
        const data = await notionFetch(`/pages/${params.page_id}`, "PATCH", {
          properties: params.properties,
        });
        if (data.object === "error") {
          return textResult(`❌ Notion update error: ${data.message}`);
        }
        return textResult(`✅ Updated Notion page: ${data.id}`);
      },
    },

    {
      name: "notion_get",
      label: "Get Notion Page",
      description: "Get full details of a Notion page by ID.",
      parameters: NotionGetParams,
      async execute(_id: string, params: Static<typeof NotionGetParams>) {
        const data = await notionFetch(`/pages/${params.page_id}`);
        if (data.object === "error") {
          return textResult(`❌ Notion get error: ${data.message}`);
        }
        const props = data.properties || {};
        const summary: Record<string, string> = { id: data.id, url: data.url };
        for (const [key, val] of Object.entries(props) as [string, any][]) {
          if (val.type === "title") summary[key] = plainText(val.title);
          else if (val.type === "rich_text") summary[key] = plainText(val.rich_text);
          else if (val.type === "select") summary[key] = val.select?.name || "";
          else if (val.type === "multi_select")
            summary[key] = val.multi_select?.map((s: any) => s.name).join(", ") || "";
          else if (val.type === "date") summary[key] = val.date?.start || "";
          else if (val.type === "number") summary[key] = String(val.number ?? "");
          else if (val.type === "url") summary[key] = val.url || "";
          else if (val.type === "checkbox") summary[key] = val.checkbox ? "Yes" : "No";
          else if (val.type === "status") summary[key] = val.status?.name || "";
        }
        return textResult(
          `## Notion Page\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\``,
        );
      },
    },
  ];
}
```

**Step 2: Commit**

```bash
git add extensions/mabos/src/tools/notion-tools.ts
git commit -m "feat(mabos): add Notion tools for marketing databases (calendar, campaigns, ads, blog, creatives)"
```

---

## Task 4: Modify `marketing-tools.ts` — Wire Brand Templates, Shopify Images, Approval Gate, Notion Sync

**Files:**

- Modify: `extensions/mabos/src/tools/marketing-tools.ts`

This is the core integration task. We modify three existing tools and add one new tool:

**Step 1: Add imports at top of `marketing-tools.ts`**

After the existing imports (line ~12), add:

```typescript
import { BRAND, fetchShopifyProduct, listShopifyProducts } from "./brand-config.js";
import { requestApproval, notifyOwner } from "./approval-gate.js";
```

**Step 2: Add new `branded_post_preview` tool**

Add a new tool to the array returned by `createMarketingTools()` (before the `content_publish` tool). This tool lets the agent preview a branded post before publishing:

```typescript
{
  name: "branded_post_preview",
  label: "Preview Branded Post",
  description:
    "Generate a branded post preview from a Shopify product handle. Returns the formatted caption, selected image, and product link following VividWalls brand guidelines. Use this before content_publish to preview what will be posted.",
  parameters: Type.Object({
    product_handle: Type.String({ description: "Shopify product handle (URL slug)" }),
    platform: Type.Union([
      Type.Literal("facebook"),
      Type.Literal("instagram"),
      Type.Literal("both"),
    ]),
    custom_caption: Type.Optional(Type.String({ description: "Override the auto-generated caption" })),
    image_index: Type.Optional(Type.Number({ description: "Which product image to use (0-based, default 0)" })),
  }),
  async execute(_id: string, params: any) {
    const product = await fetchShopifyProduct(params.product_handle);
    if (!product) return textResult(`❌ Product not found: ${params.product_handle}`);

    const imageUrl = product.images[params.image_index || 0] || product.image_url;
    const caption = params.custom_caption ||
      (params.platform === "instagram"
        ? BRAND.templates.instagramCaption(product)
        : BRAND.templates.socialPost(product));

    return textResult(`## 📋 Branded Post Preview

**Product:** ${product.title}
**Price:** $${product.price}
**Link:** ${BRAND.productUrlPattern.replace("{handle}", product.handle)}
**Image:** ${imageUrl}
**Platform:** ${params.platform}

**Caption:**
---
${caption}
---

**Brand elements:**
- ✅ Hashtags: included
- ✅ Product URL: vividwalls.co/products/${product.handle}
- ✅ Price point: $${product.price}
- ✅ Brand voice: applied

Use \`content_publish\` to publish this post (will require Telegram approval).`);
  },
},
```

**Step 3: Add `shopify_catalog` tool**

```typescript
{
  name: "shopify_catalog",
  label: "Browse Shopify Catalog",
  description:
    "List available VividWalls artwork products from Shopify for selecting which product to post or advertise.",
  parameters: Type.Object({
    limit: Type.Optional(Type.Number({ description: "Max products to return (default 25)" })),
  }),
  async execute(_id: string, params: any) {
    const products = await listShopifyProducts(params.limit || 25);
    if (products.length === 0) return textResult("❌ No products found. Check SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN.");

    const list = products.map((p, i) =>
      `${i + 1}. **${p.title}** — $${p.price}\n   Handle: \`${p.handle}\`\n   Image: ${p.image_url}`
    ).join("\n\n");

    return textResult(`## 🛍️ VividWalls Shopify Catalog (${products.length} products)\n\n${list}`);
  },
},
```

**Step 4: Modify `content_publish` execute — add approval gate**

In the `content_publish` tool's `execute` method (around line 482), insert the approval gate **before** the platform publishing loop. After the `fullText` variable is built (line ~491) and before `for (const platform of params.platforms)` (line ~493):

```typescript
// --- Telegram Approval Gate ---
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_OWNER_CHAT_ID) {
  const approval = await requestApproval({
    type: "post",
    summary: `📝 *New Post* to ${params.platforms.join(", ")}`,
    details: [
      `*Type:* ${params.content_type}`,
      `*Platforms:* ${params.platforms.join(", ")}`,
      `*Caption:* ${(params.text || "").slice(0, 200)}...`,
      params.media_url ? `*Media:* ${params.media_url}` : "",
      params.schedule_at ? `*Scheduled:* ${params.schedule_at}` : "*Publish:* Immediately",
    ]
      .filter(Boolean)
      .join("\n"),
    preview_url: params.media_url,
  });

  if (!approval.approved) {
    return textResult(
      `❌ Post rejected by ${approval.decided_by} at ${approval.decided_at}.\nNo content was published.`,
    );
  }
}
// --- End Approval Gate ---
```

**Step 5: Modify `ad_campaign_create` execute — add approval gate**

In the `ad_campaign_create` tool's `execute` method (around line 695), insert the approval gate **after** the governance budget check and **before** the platform-specific campaign creation logic (the `if (params.platform === "meta")` block at line ~753):

```typescript
// --- Telegram Approval Gate ---
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_OWNER_CHAT_ID) {
  const approval = await requestApproval({
    type: "campaign",
    summary: `📊 *New Ad Campaign:* ${params.campaign_name}`,
    details: [
      `*Platform:* ${params.platform}`,
      `*Objective:* ${params.objective}`,
      `*Budget:* $${params.daily_budget_usd}/day${params.total_budget_usd ? ` ($${params.total_budget_usd} lifetime)` : ""}`,
      `*Dates:* ${params.start_date}${params.end_date ? ` → ${params.end_date}` : " (ongoing)"}`,
      `*Targeting:* ${params.targeting.locations?.join(", ") || "default"}, ages ${params.targeting.age_min || 18}-${params.targeting.age_max || 65}`,
      `*Interests:* ${params.targeting.interests?.join(", ") || "broad"}`,
      `*Creatives:* ${params.creatives.length} ad(s)`,
    ].join("\n"),
  });

  if (!approval.approved) {
    return textResult(
      `❌ Campaign "${params.campaign_name}" rejected by ${approval.decided_by}.\nNo campaign was created.`,
    );
  }
}
// --- End Approval Gate ---
```

**Step 6: Commit**

```bash
git add extensions/mabos/src/tools/marketing-tools.ts
git commit -m "feat(mabos): wire brand templates, Shopify images, and Telegram approval gate into marketing tools"
```

---

## Task 5: Register Notion Tools in Extension Entry Point

**Files:**

- Modify: `extensions/mabos/index.ts`

**Step 1: Add import (after line ~35)**

```typescript
import { createNotionTools } from "./src/tools/notion-tools.js";
```

**Step 2: Add to factories array (after `createMarketingTools` at line ~93)**

```typescript
    createNotionTools,
```

**Step 3: Commit**

```bash
git add extensions/mabos/index.ts
git commit -m "feat(mabos): register Notion tools in MABOS extension"
```

---

## Task 6: Add Env Vars and Create Telegram Bot

**Files:**

- Modify: `.env` on VPS

**Step 1: Create a Telegram bot via @BotFather**

Message @BotFather on Telegram:

1. `/newbot`
2. Name: `VividWalls Marketing Bot`
3. Username: e.g., `vividwalls_mabos_bot`
4. Copy the bot token

**Step 2: Get your personal chat ID**

Message the new bot `/start`, then:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | python3 -m json.tool
```

Find `message.chat.id` — this is your `TELEGRAM_OWNER_CHAT_ID`.

**Step 3: Add env vars to `.env`**

```env
# Telegram Approval Bot
TELEGRAM_BOT_TOKEN=<token from BotFather>
TELEGRAM_OWNER_CHAT_ID=<your chat ID>

# Notion Database IDs
NOTION_CONTENT_CALENDAR_DB=30d859d1-bdd3-819b-bab9-c2ddb20f325b
NOTION_CAMPAIGNS_DB=e1b57d5a-35c4-499c-a68b-7e44306d395b
NOTION_ADSETS_DB=85e68ef2-97a0-4199-943f-99fc8d6a8a1d
NOTION_BLOG_DB=05717c82-1989-4a22-96d8-a314bf00278a
NOTION_CREATIVES_DB=2b3ce177-ea75-4e63-ac7e-d46d08986408
```

**Step 4: Commit .env changes (if tracked) or confirm deployed**

---

## Task 7: Build and Verify

**Step 1: Build the MABOS extension**

```bash
cd ~/openclaw-mabos && pnpm build
```

Expected: No TypeScript errors.

**Step 2: Run existing tests**

```bash
pnpm test -- --run
```

Expected: All existing tests pass.

**Step 3: Manual integration test**

Test the full flow:

1. Use `shopify_catalog` to list products
2. Use `branded_post_preview` with a product handle
3. Use `content_publish` → should trigger Telegram DM approval
4. Approve/reject via Telegram inline keyboard
5. Use `notion_query` on `content_calendar` to verify records
6. Use `ad_campaign_create` → should trigger Telegram approval
7. Verify campaign is created in Meta Ads Manager (PAUSED)

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat(mabos): branded marketing pipeline with Telegram approval and Notion integration"
```

---

## File Summary

| Action | File                                            | Purpose                                                   |
| ------ | ----------------------------------------------- | --------------------------------------------------------- |
| Create | `extensions/mabos/src/tools/brand-config.ts`    | Brand constants, templates, Shopify product fetcher       |
| Create | `extensions/mabos/src/tools/approval-gate.ts`   | Telegram DM approval with inline keyboard                 |
| Create | `extensions/mabos/src/tools/notion-tools.ts`    | Notion CRUD for 5 marketing databases                     |
| Modify | `extensions/mabos/src/tools/marketing-tools.ts` | Add approval gates, branded_post_preview, shopify_catalog |
| Modify | `extensions/mabos/index.ts`                     | Register createNotionTools                                |
| Modify | `.env`                                          | Add Telegram + Notion DB env vars                         |
