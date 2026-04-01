/**
 * Notion Tools — Content calendar, campaigns, ad sets, blog, creatives
 *
 * Provides CRUD access to configured marketing Notion databases.
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

function plainText(richText: any[]): string {
  return (richText || []).map((t: any) => t.plain_text || "").join("");
}

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
        "Query a marketing Notion database (content_calendar, campaigns, ad_sets, blog, creatives). Returns matching pages with properties.",
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
        "Create a new page in a marketing Notion database. Properties must match the database schema.",
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
