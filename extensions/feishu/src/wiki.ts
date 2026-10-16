import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { assertFeishuApiSuccess } from "./api-response.js";
import { createFeishuToolClient } from "./tool-account.js";
import { registerFeishuTool } from "./tool-registration.js";
import { feishuExternalToolResult as jsonResult, unknownToolActionResult } from "./tool-result.js";
import { FeishuWikiSchema } from "./wiki-schema.js";

const WIKI_PAGE_SIZE = 50;

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

function readWikiPageSize(params: Record<string, unknown>): number {
  return (
    readPositiveIntegerParam(params, "page_size", {
      max: WIKI_PAGE_SIZE,
      message: "page_size must be a positive integer between 1 and 50",
    }) ?? WIKI_PAGE_SIZE
  );
}

export function registerFeishuWikiTools(api: OpenClawPluginApi) {
  registerFeishuTool(api, {
    family: "wiki",
    name: "feishu_wiki",
    label: "Feishu Wiki",
    description:
      "Feishu knowledge base operations. Actions: spaces, nodes, get, create, move, rename",
    parameters: FeishuWikiSchema,
    createExecute(ctx, cfg) {
      const defaultAccountId = ctx.agentAccountId;
      return async (p) => {
        const createClient = () =>
          createFeishuToolClient({
            cfg,
            executeParams: p,
            defaultAccountId,
            requiredTool: { family: "wiki", label: "Wiki" },
          });
        switch (p.action) {
          case "spaces": {
            const pageToken = p.page_token;
            const res = await createClient().wiki.space.list({
              params: { page_size: readWikiPageSize(p), page_token: pageToken },
            });
            assertFeishuApiSuccess(res);
            const spaces =
              res.data?.items?.map((s) => ({
                space_id: s.space_id,
                name: s.name,
                description: s.description,
                visibility: s.visibility,
              })) ?? [];
            return jsonResult({
              spaces,
              has_more: res.data?.has_more ?? false,
              page_token: res.data?.page_token,
              ...(spaces.length === 0 &&
                pageToken === undefined &&
                res.data?.has_more !== true && { hint: WIKI_ACCESS_HINT }),
            });
          }
          case "nodes": {
            const spaceId = requireWikiSpaceId(p.space_id, "space_id");
            const res = await createClient().wiki.spaceNode.list({
              path: { space_id: spaceId },
              params: {
                parent_node_token: p.parent_node_token,
                page_size: readWikiPageSize(p),
                page_token: p.page_token,
              },
            });
            assertFeishuApiSuccess(res);
            return jsonResult({
              nodes:
                res.data?.items?.map((n) => ({
                  node_token: n.node_token,
                  obj_token: n.obj_token,
                  obj_type: n.obj_type,
                  title: n.title,
                  has_child: n.has_child,
                })) ?? [],
              has_more: res.data?.has_more ?? false,
              page_token: res.data?.page_token,
            });
          }
          case "get": {
            const res = await createClient().wiki.space.getNode({ params: { token: p.token } });
            assertFeishuApiSuccess(res);
            const node = res.data?.node;
            return jsonResult({
              node_token: node?.node_token,
              space_id: node?.space_id,
              obj_token: node?.obj_token,
              obj_type: node?.obj_type,
              title: node?.title,
              parent_node_token: node?.parent_node_token,
              has_child: node?.has_child,
              creator: node?.creator,
              create_time: node?.node_create_time,
            });
          }
          case "search":
            optionalWikiSpaceId(p.space_id, "space_id");
            createClient();
            return jsonResult({
              error:
                "Search is not available. Use feishu_wiki with action: 'nodes' to browse or action: 'get' to lookup by token.",
            });
          case "create": {
            const spaceId = requireWikiSpaceId(p.space_id, "space_id");
            const res = await createClient().wiki.spaceNode.create({
              path: { space_id: spaceId },
              data: {
                obj_type: p.obj_type || "docx",
                node_type: "origin",
                title: p.title,
                parent_node_token: p.parent_node_token,
              },
            });
            assertFeishuApiSuccess(res);
            const node = res.data?.node;
            return jsonResult({
              node_token: node?.node_token,
              obj_token: node?.obj_token,
              obj_type: node?.obj_type,
              title: node?.title,
            });
          }
          case "move": {
            const spaceId = requireWikiSpaceId(p.space_id, "space_id");
            const res = await createClient().wiki.spaceNode.move({
              path: { space_id: spaceId, node_token: p.node_token },
              data: {
                target_space_id:
                  optionalWikiSpaceId(p.target_space_id, "target_space_id") || spaceId,
                target_parent_token: p.target_parent_token,
              },
            });
            assertFeishuApiSuccess(res);
            return jsonResult({ success: true, node_token: res.data?.node?.node_token });
          }
          case "rename": {
            const spaceId = requireWikiSpaceId(p.space_id, "space_id");
            const { node_token, title } = p;
            const res = await createClient().wiki.spaceNode.updateTitle({
              path: { space_id: spaceId, node_token },
              data: { title },
            });
            assertFeishuApiSuccess(res);
            return jsonResult({ success: true, node_token, title });
          }
          default:
            return unknownToolActionResult((p as { action?: unknown }).action);
        }
      };
    },
  });
}
