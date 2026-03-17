import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";
import {
  jsonToolResult,
  toolExecutionErrorResult,
  unknownToolActionResult
} from "./tool-result.js";
import { FeishuWikiSchema } from "./wiki-schema.js";
const WIKI_ACCESS_HINT = "To grant wiki access: Open wiki space \u2192 Settings \u2192 Members \u2192 Add the bot. See: https://open.feishu.cn/document/server-docs/docs/wiki-v2/wiki-qa#a40ad4ca";
async function listSpaces(client) {
  const res = await client.wiki.space.list({});
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  const spaces = res.data?.items?.map((s) => ({
    space_id: s.space_id,
    name: s.name,
    description: s.description,
    visibility: s.visibility
  })) ?? [];
  return {
    spaces,
    ...spaces.length === 0 && { hint: WIKI_ACCESS_HINT }
  };
}
async function listNodes(client, spaceId, parentNodeToken) {
  const res = await client.wiki.spaceNode.list({
    path: { space_id: spaceId },
    params: { parent_node_token: parentNodeToken }
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return {
    nodes: res.data?.items?.map((n) => ({
      node_token: n.node_token,
      obj_token: n.obj_token,
      obj_type: n.obj_type,
      title: n.title,
      has_child: n.has_child
    })) ?? []
  };
}
async function getNode(client, token) {
  const res = await client.wiki.space.getNode({
    params: { token }
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
    create_time: node?.node_create_time
  };
}
async function createNode(client, spaceId, title, objType, parentNodeToken) {
  const res = await client.wiki.spaceNode.create({
    path: { space_id: spaceId },
    data: {
      obj_type: objType || "docx",
      node_type: "origin",
      title,
      parent_node_token: parentNodeToken
    }
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  const node = res.data?.node;
  return {
    node_token: node?.node_token,
    obj_token: node?.obj_token,
    obj_type: node?.obj_type,
    title: node?.title
  };
}
async function moveNode(client, spaceId, nodeToken, targetSpaceId, targetParentToken) {
  const res = await client.wiki.spaceNode.move({
    path: { space_id: spaceId, node_token: nodeToken },
    data: {
      target_space_id: targetSpaceId || spaceId,
      target_parent_token: targetParentToken
    }
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return {
    success: true,
    node_token: res.data?.node?.node_token
  };
}
async function renameNode(client, spaceId, nodeToken, title) {
  const res = await client.wiki.spaceNode.updateTitle({
    path: { space_id: spaceId, node_token: nodeToken },
    data: { title }
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return {
    success: true,
    node_token: nodeToken,
    title
  };
}
function registerFeishuWikiTools(api) {
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
  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        name: "feishu_wiki",
        label: "Feishu Wiki",
        description: "Feishu knowledge base operations. Actions: spaces, nodes, get, create, move, rename",
        parameters: FeishuWikiSchema,
        async execute(_toolCallId, params) {
          const p = params;
          try {
            const client = createFeishuToolClient({
              api,
              executeParams: p,
              defaultAccountId
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
                  error: "Search is not available. Use feishu_wiki with action: 'nodes' to browse or action: 'get' to lookup by token."
                });
              case "create":
                return jsonToolResult(
                  await createNode(client, p.space_id, p.title, p.obj_type, p.parent_node_token)
                );
              case "move":
                return jsonToolResult(
                  await moveNode(
                    client,
                    p.space_id,
                    p.node_token,
                    p.target_space_id,
                    p.target_parent_token
                  )
                );
              case "rename":
                return jsonToolResult(await renameNode(client, p.space_id, p.node_token, p.title));
              default:
                return unknownToolActionResult(p.action);
            }
          } catch (err) {
            return toolExecutionErrorResult(err);
          }
        }
      };
    },
    { name: "feishu_wiki" }
  );
  api.logger.info?.(`feishu_wiki: Registered feishu_wiki tool`);
}
export {
  registerFeishuWikiTools
};
