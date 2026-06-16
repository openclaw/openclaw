// Feishu plugin module implements wiki behavior.
import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";
import {
  jsonToolResult,
  toolExecutionErrorResult,
  unknownToolActionResult,
} from "./tool-result.js";
import { FeishuWikiSchema, type FeishuWikiParams } from "./wiki-schema.js";

type ObjType = "doc" | "sheet" | "mindnote" | "bitable" | "file" | "docx" | "slides";

// Feishu wiki list endpoints are paginated (max 50 per page). Without following
// `page_token` the tool silently truncates to the first page and drops the rest
// (#37626). Cap the page count so a malformed `has_more` response cannot loop
// forever.
const WIKI_PAGE_SIZE = 50;
const WIKI_MAX_PAGES = 100;

// Drain a Feishu paginated list endpoint. Feishu may return `has_more: true`
// with an empty page, so we loop on `has_more` rather than item count, and stop
// if a continuation is promised without a `page_token` (otherwise we would spin
// on the same page).
async function collectPaged<T>(
  fetchPage: (pageToken: string | undefined) => Promise<{
    code: number;
    msg?: string;
    items?: T[];
    pageToken?: string;
    hasMore?: boolean;
  }>,
): Promise<T[]> {
  const all: T[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < WIKI_MAX_PAGES; page++) {
    const res = await fetchPage(pageToken);
    if (res.code !== 0) {
      throw new Error(res.msg);
    }
    if (res.items) {
      all.push(...res.items);
    }
    if (!res.hasMore || !res.pageToken) {
      break;
    }
    pageToken = res.pageToken;
  }
  return all;
}

// ============ Actions ============

const WIKI_ACCESS_HINT =
  "To grant wiki access: Open wiki space → Settings → Members → Add the bot. " +
  "See: https://open.feishu.cn/document/server-docs/docs/wiki-v2/wiki-qa#a40ad4ca";

function requireWikiSpaceId(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(
      `${fieldName} must be a string. Feishu wiki space IDs are opaque identifiers; pass them quoted to avoid JavaScript number precision loss.`,
    );
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} must not be empty.`);
  }

  return trimmed;
}

function optionalWikiSpaceId(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return requireWikiSpaceId(value, fieldName);
}

async function listSpaces(client: Lark.Client) {
  const items = await collectPaged(async (pageToken) => {
    const res = await client.wiki.space.list({
      params: { page_size: WIKI_PAGE_SIZE, page_token: pageToken },
    });
    return {
      code: res.code,
      msg: res.msg,
      items: res.data?.items,
      pageToken: res.data?.page_token,
      hasMore: res.data?.has_more,
    };
  });

  const spaces = items.map((s) => ({
    space_id: s.space_id,
    name: s.name,
    description: s.description,
    visibility: s.visibility,
  }));

  return {
    spaces,
    ...(spaces.length === 0 && { hint: WIKI_ACCESS_HINT }),
  };
}

async function listNodes(client: Lark.Client, spaceId: string, parentNodeToken?: string) {
  const items = await collectPaged(async (pageToken) => {
    const res = await client.wiki.spaceNode.list({
      path: { space_id: spaceId },
      params: {
        parent_node_token: parentNodeToken,
        page_size: WIKI_PAGE_SIZE,
        page_token: pageToken,
      },
    });
    return {
      code: res.code,
      msg: res.msg,
      items: res.data?.items,
      pageToken: res.data?.page_token,
      hasMore: res.data?.has_more,
    };
  });

  return {
    nodes: items.map((n) => ({
      node_token: n.node_token,
      obj_token: n.obj_token,
      obj_type: n.obj_type,
      title: n.title,
      has_child: n.has_child,
    })),
  };
}

async function getNode(client: Lark.Client, token: string) {
  const res = await client.wiki.space.getNode({
    params: { token },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const node = res.data?.node;
  return {
    node_token: node?.node_token,
    space_id: node?.space_id,
    obj_token: node?.obj_token,
    obj_type: node?.obj_type,
    title: node?.title,
    parent_node_token: node?.parent_node_token,
    has_child: node?.has_child,
    creator: node?.creator,
    create_time: node?.node_create_time,
  };
}

async function createNode(
  client: Lark.Client,
  spaceId: string,
  title: string,
  objType?: string,
  parentNodeToken?: string,
) {
  const res = await client.wiki.spaceNode.create({
    path: { space_id: spaceId },
    data: {
      obj_type: (objType as ObjType) || "docx",
      node_type: "origin" as const,
      title,
      parent_node_token: parentNodeToken,
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const node = res.data?.node;
  return {
    node_token: node?.node_token,
    obj_token: node?.obj_token,
    obj_type: node?.obj_type,
    title: node?.title,
  };
}

async function moveNode(
  client: Lark.Client,
  spaceId: string,
  nodeToken: string,
  targetSpaceId?: string,
  targetParentToken?: string,
) {
  const res = await client.wiki.spaceNode.move({
    path: { space_id: spaceId, node_token: nodeToken },
    data: {
      target_space_id: targetSpaceId || spaceId,
      target_parent_token: targetParentToken,
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
    node_token: res.data?.node?.node_token,
  };
}

async function renameNode(client: Lark.Client, spaceId: string, nodeToken: string, title: string) {
  const res = await client.wiki.spaceNode.updateTitle({
    path: { space_id: spaceId, node_token: nodeToken },
    data: { title },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
    node_token: nodeToken,
    title,
  };
}

// ============ Tool Registration ============

export function registerFeishuWikiTools(api: OpenClawPluginApi) {
  if (!api.config) {
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.wiki) {
    return;
  }

  type FeishuWikiExecuteParams = FeishuWikiParams & { accountId?: string };

  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        name: "feishu_wiki",
        label: "Feishu Wiki",
        description:
          "Feishu knowledge base operations. Actions: spaces, nodes, get, create, move, rename",
        parameters: FeishuWikiSchema,
        async execute(_toolCallId, params) {
          const p = params as FeishuWikiExecuteParams;
          try {
            const createClient = () =>
              createFeishuToolClient({
                api,
                executeParams: p,
                defaultAccountId,
              });
            switch (p.action) {
              case "spaces":
                return jsonToolResult(await listSpaces(createClient()));
              case "nodes": {
                const spaceId = requireWikiSpaceId(p.space_id, "space_id");
                return jsonToolResult(
                  await listNodes(createClient(), spaceId, p.parent_node_token),
                );
              }
              case "get":
                return jsonToolResult(await getNode(createClient(), p.token));
              case "search":
                optionalWikiSpaceId(p.space_id, "space_id");
                createClient();
                return jsonToolResult({
                  error:
                    "Search is not available. Use feishu_wiki with action: 'nodes' to browse or action: 'get' to lookup by token.",
                });
              case "create": {
                const spaceId = requireWikiSpaceId(p.space_id, "space_id");
                return jsonToolResult(
                  await createNode(
                    createClient(),
                    spaceId,
                    p.title,
                    p.obj_type,
                    p.parent_node_token,
                  ),
                );
              }
              case "move": {
                const spaceId = requireWikiSpaceId(p.space_id, "space_id");
                return jsonToolResult(
                  await moveNode(
                    createClient(),
                    spaceId,
                    p.node_token,
                    optionalWikiSpaceId(p.target_space_id, "target_space_id"),
                    p.target_parent_token,
                  ),
                );
              }
              case "rename": {
                const spaceId = requireWikiSpaceId(p.space_id, "space_id");
                return jsonToolResult(
                  await renameNode(createClient(), spaceId, p.node_token, p.title),
                );
              }
              default:
                return unknownToolActionResult((p as { action?: unknown }).action);
            }
          } catch (err) {
            return toolExecutionErrorResult(err);
          }
        },
      };
    },
    { name: "feishu_wiki" },
  );
}
