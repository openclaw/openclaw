import { optionalPositiveIntegerSchema } from "openclaw/plugin-sdk/channel-actions";
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import { Type } from "typebox";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { assertFeishuApiSuccess } from "./api-response.js";
import { registerFeishuTool } from "./tool-registration.js";
import { feishuExternalToolResult as jsonResult, unknownToolActionResult } from "./tool-result.js";

const WIKI_PAGE_SIZE = 50;
const WIKI_SPACE_ID_DESCRIPTION =
  "Knowledge space ID. Treat as an opaque string and keep it quoted; never pass numeric-looking IDs as numbers.";

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
    parameters: Type.Union([
      Type.Object({
        action: Type.Literal("spaces"),
        page_size: optionalPositiveIntegerSchema({
          maximum: 50,
          description: "Page size (1-50, default 50)",
        }),
        page_token: Type.Optional(Type.String({ description: "Pagination token" })),
      }),
      Type.Object({
        action: Type.Literal("nodes"),
        space_id: Type.String({ description: WIKI_SPACE_ID_DESCRIPTION }),
        parent_node_token: Type.Optional(
          Type.String({ description: "Parent node token (optional, omit for root)" }),
        ),
        page_size: optionalPositiveIntegerSchema({
          maximum: 50,
          description: "Page size (1-50, default 50)",
        }),
        page_token: Type.Optional(Type.String({ description: "Pagination token" })),
      }),
      Type.Object({
        action: Type.Literal("get"),
        token: Type.String({ description: "Wiki node token (from URL /wiki/XXX)" }),
      }),
      Type.Object({
        action: Type.Literal("search"),
        query: Type.String({ description: "Search query" }),
        space_id: Type.Optional(
          Type.String({
            description:
              "Limit search to this knowledge space. Treat as an opaque string and keep it quoted; never pass numeric-looking IDs as numbers.",
          }),
        ),
      }),
      Type.Object({
        action: Type.Literal("create"),
        space_id: Type.String({ description: WIKI_SPACE_ID_DESCRIPTION }),
        title: Type.String({ description: "Node title" }),
        obj_type: Type.Optional(
          Type.Union([Type.Literal("docx"), Type.Literal("sheet"), Type.Literal("bitable")], {
            description: "Object type (default: docx)",
          }),
        ),
        parent_node_token: Type.Optional(
          Type.String({ description: "Parent node token (optional, omit for root)" }),
        ),
      }),
      Type.Object({
        action: Type.Literal("move"),
        space_id: Type.String({
          description:
            "Source knowledge space ID. Treat as an opaque string and keep it quoted; never pass numeric-looking IDs as numbers.",
        }),
        node_token: Type.String({ description: "Node token to move" }),
        target_space_id: Type.Optional(
          Type.String({
            description:
              "Target knowledge space ID (optional, same space if omitted). Treat as an opaque string and keep it quoted; never pass numeric-looking IDs as numbers.",
          }),
        ),
        target_parent_token: Type.Optional(
          Type.String({ description: "Target parent node token (optional, root if omitted)" }),
        ),
      }),
      Type.Object({
        action: Type.Literal("rename"),
        space_id: Type.String({ description: WIKI_SPACE_ID_DESCRIPTION }),
        node_token: Type.String({ description: "Node token to rename" }),
        title: Type.String({ description: "New title" }),
      }),
    ]),
    createExecute(_ctx, _cfg, createToolClient) {
      return async (p) => {
        const createClient = () => createToolClient(p, "Wiki");
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
