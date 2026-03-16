import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";
import {
  jsonToolResult,
  toolExecutionErrorResult,
  unknownToolActionResult,
} from "./tool-result.js";
import { FeishuWikiSchema, type FeishuWikiParams } from "./wiki-schema.js";

type ObjType = "doc" | "sheet" | "mindnote" | "bitable" | "file" | "docx" | "slides";

// ============ Actions ============

const WIKI_ACCESS_HINT =
  "To grant wiki access: Open wiki space → Settings → Members → Add the bot. " +
  "See: https://open.feishu.cn/document/server-docs/docs/wiki-v2/wiki-qa#a40ad4ca";

async function listSpaces(client: Lark.Client) {
  const res = await client.wiki.space.list({});
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const spaces =
    res.data?.items?.map((s) => ({
      space_id: s.space_id,
      name: s.name,
      description: s.description,
      visibility: s.visibility,
    })) ?? [];

  return {
    spaces,
    ...(spaces.length === 0 && { hint: WIKI_ACCESS_HINT }),
  };
}

async function listNodes(client: Lark.Client, spaceId: string, parentNodeToken?: string) {
  const allNodes: Array<{
    node_token?: string;
    obj_token?: string;
    obj_type?: string;
    title?: string;
    has_child?: boolean;
  }> = [];
  
  let pageToken: string | undefined = undefined;
  let pageCount = 0;
  const maxPages = 100; // Safety limit to prevent infinite loops
  
  do {
    const res = await client.wiki.spaceNode.list({
      path: { space_id: spaceId },
      params: {
        parent_node_token: parentNodeToken,
        page_size: 50, // Max allowed by Feishu API
        page_token: pageToken,
      },
    });
    
    if (res.code !== 0) {
      throw new Error(res.msg);
    }
    
    // Collect nodes from current page
    if (res.data?.items) {
      allNodes.push(
        ...res.data.items.map((n) => ({
          node_token: n.node_token,
          obj_token: n.obj_token,
          obj_type: n.obj_type,
          title: n.title,
          has_child: n.has_child,
        }))
      );
    }
    
    // Check if there are more pages
    const hasMore = res.data?.has_more === true;
    pageToken = res.data?.page_token;
    pageCount++;
    
    // Safety limit: stop at 100 pages (5000 nodes)
    if (pageCount >= maxPages && hasMore) {
      console.warn(
        `[feishu_wiki] Reached pagination limit (${maxPages} pages, ${allNodes.length} nodes). ` +
        `Space may have more nodes. space_id=${spaceId}, parent=${parentNodeToken || 'root'}`
      );
    }
    
    // Continue fetching if there are more pages and we haven't hit the safety limit.
    // Log a warning if the API signals more pages but returns no page_token — this
    // indicates an unexpected API response and avoids silent data truncation.
    if (!hasMore || pageCount >= maxPages) {
      break;
    }
    if (!pageToken) {
      console.warn(
        `[feishu_wiki] API returned has_more=true but no page_token — stopping pagination. ` +
        `space_id=${spaceId}, page=${pageCount}, nodes=${allNodes.length}`
      );
      break;
    }
  } while (true);

  return {
    nodes: allNodes,
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
    api.logger.debug?.("feishu_wiki: No config available, skipping wiki tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_wiki: No Feishu accounts configured, skipping wiki tools");
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.wiki) {
    api.logger.debug?.("feishu_wiki: wiki tool disabled in config");
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
            const client = createFeishuToolClient({
              api,
              executeParams: p,
              defaultAccountId,
            });
            switch (p.action) {
              case "spaces":
                return jsonToolResult(await listSpaces(client));
              case "nodes":
                return jsonToolResult(await listNodes(client, p.space_id, p.parent_node_token));
              case "get":
                return jsonToolResult(await getNode(client, p.token));
              case "search":
                return jsonToolResult({
                  error:
                    "Search is not available. Use feishu_wiki with action: 'nodes' to browse or action: 'get' to lookup by token.",
                });
              case "create":
                return jsonToolResult(
                  await createNode(client, p.space_id, p.title, p.obj_type, p.parent_node_token),
                );
              case "move":
                return jsonToolResult(
                  await moveNode(
                    client,
                    p.space_id,
                    p.node_token,
                    p.target_space_id,
                    p.target_parent_token,
                  ),
                );
              case "rename":
                return jsonToolResult(await renameNode(client, p.space_id, p.node_token, p.title));
              default:
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exhaustive check fallback
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

  api.logger.info?.(`feishu_wiki: Registered feishu_wiki tool`);
}
