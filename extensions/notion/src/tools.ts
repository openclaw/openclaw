import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { NotionApiClient } from "./client.js";
import { resolveNotionToken } from "./credentials.js";
import { mapNotionError } from "./errors.js";

const NOTION_WRITE_TOOL_NAMES = new Set([
  "notion_create_page",
  "notion_update_page",
  "notion_create_data_source",
  "notion_update_data_source",
  "notion_append_block_children",
  "notion_update_block",
  "notion_delete_block",
  "notion_delete_page",
  "notion_create_comment",
  "notion_update_comment",
]);

function isNotionWriteToolName(name: string): boolean {
  return NOTION_WRITE_TOOL_NAMES.has(name);
}

function summarizeNotionWriteApproval(toolName: string, params: Record<string, unknown>): string {
  const objectSummary =
    typeof params.pageId === "string"
      ? `Page ${params.pageId}`
      : typeof params.dataSourceId === "string"
        ? `Data source ${params.dataSourceId}`
        : typeof params.parentDatabaseId === "string"
          ? `Database ${params.parentDatabaseId}`
          : typeof params.blockId === "string"
            ? `Block ${params.blockId}`
            : "Notion resource";

  const changedFields = [
    params.properties ? "properties" : null,
    params.content ? "content" : null,
    params.appendContent ? "content append" : null,
    params.children ? "append children" : null,
    params.block ? "block update" : null,
    params.addProperties ? "schema changes" : null,
    params.renameProperties ? "property rename" : null,
    params.eraseContent ? "content erase" : null,
    params.archive ? "trash" : null,
    params.restore ? "restore" : null,
    params.inTrash === true ? "trash" : params.inTrash === false ? "restore" : null,
  ].filter((entry) => !!entry);

  return `${toolName} will modify ${objectSummary}. Requested changes: ${changedFields.length > 0 ? changedFields.join(", ") : "content or schema change"}.`;
}

const notionPlugin = definePluginEntry({
  id: "notion",
  name: "Notion",
  description: "Bundled Notion REST plugin",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      safety: {
        type: "object",
        additionalProperties: false,
        properties: {
          writeApprovalMode: {
            type: "string",
            enum: ["per_call", "disabled"],
          },
        },
      },
    },
  },
  register(api) {
    const config = (api.pluginConfig as { safety?: { writeApprovalMode?: string } }) || {};

    const notionClient = new NotionApiClient({
      baseUrl: "https://api.notion.com/v1",
      token: resolveNotionToken(),
    });

    if (config.safety?.writeApprovalMode === "per_call") {
      api.on("before_tool_call", (event) => {
        if (!isNotionWriteToolName(event.toolName)) {
          return;
        }
        return {
          requireApproval: {
            pluginId: "notion",
            title: `Notion write: ${event.toolName.replace(/^notion_/, "").replace(/_/g, " ")}`,
            description: summarizeNotionWriteApproval(event.toolName, event.params),
            severity: "warning",
            timeoutBehavior: "deny",
          },
        };
      });
    }

    api.registerTool(
      () => ({
        name: "notion_search",
        label: "Notion Search",
        description: "Search Notion pages and data sources shared with the integration.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            kind: { type: "string", enum: ["page", "data_source", "all"] },
            pageSize: { type: "number" },
            cursor: { type: "string" },
          },
        },
        async execute(params) {
          const result = await notionClient.search(
            params.query as string,
            params.kind as string,
            params.pageSize as number,
            params.cursor as string,
          );
          if (!result.ok) {
            throw mapNotionError(result.error);
          }
          return { ok: true, data: result.data };
        },
      }),
      { name: "notion_search", optional: true },
    );

    api.registerTool(
      () => ({
        name: "notion_fetch",
        label: "Notion Fetch",
        description:
          "Fetch a Notion page or data source by UUID or URL, optionally including page blocks.",
        parameters: {
          type: "object",
          properties: {
            target: { type: "string" },
            targetType: { type: "string", enum: ["auto", "page", "data_source"] },
            includeBlocks: { type: "boolean" },
            blockPageSize: { type: "number" },
            blockCursor: { type: "string" },
          },
          required: ["target"],
        },
        async execute(params) {
          const result = await notionClient.fetchPage(
            params.target as string,
            params.targetType as "auto" | "page" | "data_source" | undefined,
            params.includeBlocks as boolean,
            params.blockPageSize as number,
            params.blockCursor as string,
          );
          if (!result.ok) {
            throw mapNotionError(result.error);
          }
          return { ok: true, data: result.data };
        },
      }),
      { name: "notion_fetch", optional: true },
    );

    api.registerTool(
      () => ({
        name: "notion_query_data_source",
        label: "Notion Query Data Source",
        description: "Query rows from a Notion data source using a stable internal filter DSL.",
        parameters: {
          type: "object",
          properties: {
            dataSource: { type: "string" },
            filter: { type: "object" },
            sorts: { type: "array" },
            pageSize: { type: "number" },
            cursor: { type: "string" },
          },
          required: ["dataSource"],
        },
        async execute(params) {
          const result = await notionClient.queryDataSource(
            params.dataSource as string,
            params.filter,
            params.sorts,
            params.pageSize as number,
            params.cursor as string,
          );
          if (!result.ok) {
            throw mapNotionError(result.error);
          }
          return { ok: true, data: result.data };
        },
      }),
      { name: "notion_query_data_source", optional: true },
    );

    api.registerTool(
      () => ({
        name: "notion_create_page",
        label: "Notion Create Page",
        description:
          "Create a page in a Notion page or data source using typed property and block payloads.",
        parameters: {
          type: "object",
          properties: {
            parent: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["page", "data_source"] },
                id: { type: "string" },
              },
              required: ["type", "id"],
            },
            properties: { type: "object" },
            content: { type: "array" },
            icon: { type: "object" },
            cover: { type: "object" },
          },
          required: ["parent", "properties"],
        },
        async execute(params) {
          const result = await notionClient.createPage(
            params.parent as { type: string; id: string },
            params.properties,
            params.content,
            params.icon,
            params.cover,
          );
          if (!result.ok) {
            throw mapNotionError(result.error);
          }
          return { ok: true, data: { page: result.data } };
        },
      }),
      { name: "notion_create_page", optional: true },
    );

    api.registerTool(
      () => ({
        name: "notion_update_page",
        label: "Notion Update Page",
        description:
          "Update page properties, trash state, or content append/erase behavior for a Notion page.",
        parameters: {
          type: "object",
          properties: {
            pageId: { type: "string" },
            properties: { type: "object" },
            appendContent: { type: "array" },
            icon: { type: "object" },
            cover: { type: "object" },
            eraseContent: { type: "boolean" },
            archive: { type: "boolean" },
            restore: { type: "boolean" },
          },
          required: ["pageId"],
        },
        async execute(params) {
          const result = await notionClient.updatePage(
            params.pageId as string,
            params.properties,
            params.appendContent,
            params.icon,
            params.cover,
            params.eraseContent as boolean,
            params.archive as boolean,
            params.restore as boolean,
          );
          if (!result.ok) {
            throw mapNotionError(result.error);
          }
          return { ok: true, data: { page: result.data } };
        },
      }),
      { name: "notion_update_page", optional: true },
    );

    api.registerTool(
      () => ({
        name: "notion_create_data_source",
        label: "Notion Create Data Source",
        description: "Create an additional Notion data source under an existing database.",
        parameters: {
          type: "object",
          properties: {
            parentDatabaseId: { type: "string" },
            title: { type: "string" },
            properties: { type: "object" },
            icon: { type: "object" },
          },
          required: ["parentDatabaseId", "title", "properties"],
        },
        async execute(params) {
          const result = await notionClient.createDataSource(
            params.parentDatabaseId as string,
            params.title as string,
            params.properties,
            params.icon,
          );
          if (!result.ok) {
            throw mapNotionError(result.error);
          }
          return { ok: true, data: { dataSource: result.data } };
        },
      }),
      { name: "notion_create_data_source", optional: true },
    );

    api.registerTool(
      () => ({
        name: "notion_update_data_source",
        label: "Notion Update Data Source",
        description:
          "Rename or extend a Notion data source schema, move it to another database, or change trash state.",
        parameters: {
          type: "object",
          properties: {
            dataSourceId: { type: "string" },
            title: { type: "string" },
            addProperties: { type: "object" },
            renameProperties: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  from: { type: "string" },
                  to: { type: "string" },
                },
              },
            },
            parentDatabaseId: { type: "string" },
            inTrash: { type: "boolean" },
            icon: { type: "object" },
          },
          required: ["dataSourceId"],
        },
        async execute(params) {
          const result = await notionClient.updateDataSource(
            params.dataSourceId as string,
            params.title as string,
            params.addProperties,
            params.renameProperties,
            params.parentDatabaseId as string,
            params.inTrash as boolean,
            params.icon,
          );
          if (!result.ok) {
            throw mapNotionError(result.error);
          }
          return { ok: true, data: { dataSource: result.data } };
        },
      }),
      { name: "notion_update_data_source", optional: true },
    );

    api.registerTool(
      () => ({
        name: "notion_get_block",
        label: "Notion Get Block",
        description: "Retrieve a single block by ID from Notion.",
        parameters: {
          type: "object",
          properties: {
            blockId: { type: "string" },
          },
          required: ["blockId"],
        },
        async execute(params) {
          const result = await notionClient.getBlock(params.blockId as string);
          if (!result.ok) {
            throw mapNotionError(result.error);
          }
          return { ok: true, data: { block: result.data } };
        },
      }),
      { name: "notion_get_block", optional: true },
    );

    api.registerTool(
      () => ({
        name: "notion_get_block_children",
        label: "Notion Get Block Children",
        description: "Retrieve children blocks of a block or page with pagination support.",
        parameters: {
          type: "object",
          properties: {
            blockId: { type: "string" },
            pageSize: { type: "number" },
            cursor: { type: "string" },
          },
          required: ["blockId"],
        },
        async execute(params) {
          const result = await notionClient.getBlockChildren(
            params.blockId as string,
            params.pageSize as number,
            params.cursor as string,
          );
          if (!result.ok) {
            throw mapNotionError(result.error);
          }
          return { ok: true, data: result.data };
        },
      }),
      { name: "notion_get_block_children", optional: true },
    );

    api.registerTool(
      () => ({
        name: "notion_append_block_children",
        label: "Notion Append Block Children",
        description: "Add new blocks to a page or block. This is a write operation.",
        parameters: {
          type: "object",
          properties: {
            blockId: { type: "string" },
            children: {
              type: "array",
              items: { type: "object" },
            },
          },
          required: ["blockId", "children"],
        },
        async execute(params) {
          const result = await notionClient.appendBlockChildren(
            params.blockId as string,
            params.children as unknown[],
          );
          if (!result.ok) {
            throw mapNotionError(result.error);
          }
          return { ok: true, data: result.data };
        },
      }),
      { name: "notion_append_block_children", optional: true },
    );

    api.registerTool(
      () => ({
        name: "notion_update_block",
        label: "Notion Update Block",
        description: "Modify existing block content. This is a write operation.",
        parameters: {
          type: "object",
          properties: {
            blockId: { type: "string" },
            block: { type: "object" },
          },
          required: ["blockId", "block"],
        },
        async execute(params) {
          const result = await notionClient.updateBlock(params.blockId as string, params.block);
          if (!result.ok) {
            throw mapNotionError(result.error);
          }
          return { ok: true, data: { block: result.data } };
        },
      }),
      { name: "notion_update_block", optional: true },
    );

    api.registerTool(
      () => ({
        name: "notion_delete_block",
        label: "Notion Delete Block",
        description: "Archive/delete a block. This is a write operation.",
        parameters: {
          type: "object",
          properties: {
            blockId: { type: "string" },
          },
          required: ["blockId"],
        },
        async execute(params) {
          const result = await notionClient.deleteBlock(params.blockId as string);
          if (!result.ok) {
            throw mapNotionError(result.error);
          }
          return { ok: true, data: { id: params.blockId, archived: true } };
        },
      }),
      { name: "notion_delete_block", optional: true },
    );

    api.registerTool(
      () => ({
        name: "notion_get_database",
        label: "Notion Get Database",
        description: "Retrieve database schema and metadata by ID.",
        parameters: {
          type: "object",
          properties: {
            databaseId: { type: "string" },
          },
          required: ["databaseId"],
        },
        async execute(params) {
          const result = await notionClient.getDatabase(params.databaseId as string);
          if (!result.ok) {
            throw mapNotionError(result.error);
          }
          return { ok: true, data: { database: result.data } };
        },
      }),
      { name: "notion_get_database", optional: true },
    );

    api.registerTool(
      () => ({
        name: "notion_delete_page",
        label: "Notion Delete Page",
        description: "Archive/remove a page. This is a write operation.",
        parameters: {
          type: "object",
          properties: {
            pageId: { type: "string" },
          },
          required: ["pageId"],
        },
        async execute(params) {
          const result = await notionClient.deletePage(params.pageId as string);
          if (!result.ok) {
            throw mapNotionError(result.error);
          }
          return { ok: true, data: { page: result.data } };
        },
      }),
      { name: "notion_delete_page", optional: true },
    );

    // Phase 3: User operations
    api.registerTool(
      () => ({
        name: "notion_get_user",
        label: "Notion Get User",
        description: "Retrieve user information by ID.",
        parameters: {
          type: "object",
          properties: {
            userId: { type: "string" },
          },
          required: ["userId"],
        },
        async execute(params) {
          const result = await notionClient.getUser(params.userId as string);
          if (!result.ok) {
            throw mapNotionError(result.error);
          }
          return { ok: true, data: { user: result.data } };
        },
      }),
      { name: "notion_get_user", optional: true },
    );

    api.registerTool(
      () => ({
        name: "notion_list_users",
        label: "Notion List Users",
        description: "List all users in the workspace.",
        parameters: {
          type: "object",
          properties: {},
        },
        async execute() {
          const result = await notionClient.listUsers();
          if (!result.ok) {
            throw mapNotionError(result.error);
          }
          return { ok: true, data: result.data };
        },
      }),
      { name: "notion_list_users", optional: true },
    );

    // Phase 4: Comment operations
    api.registerTool(
      () => ({
        name: "notion_get_comments",
        label: "Notion Get Comments",
        description: "Retrieve comments for a block or page with pagination support.",
        parameters: {
          type: "object",
          properties: {
            blockId: { type: "string" },
            pageSize: { type: "number" },
            cursor: { type: "string" },
          },
          required: ["blockId"],
        },
        async execute(params) {
          const result = await notionClient.getComments(
            params.blockId as string,
            params.pageSize as number,
            params.cursor as string,
          );
          if (!result.ok) {
            throw mapNotionError(result.error);
          }
          return { ok: true, data: result.data };
        },
      }),
      { name: "notion_get_comments", optional: true },
    );

    api.registerTool(
      () => ({
        name: "notion_create_comment",
        label: "Notion Create Comment",
        description:
          "Create a comment on a block, page, or existing discussion thread. This is a write operation.",
        parameters: {
          type: "object",
          properties: {
            blockId: { type: "string" },
            richText: { type: "array" },
            discussionId: { type: "string" },
            parentId: { type: "string" },
            parentType: { type: "string", enum: ["page_id", "block_id"] },
          },
          required: ["richText"],
        },
        async execute(params) {
          const result = await notionClient.createComment({
            richText: params.richText as unknown[],
            targetId: params.blockId as string | undefined,
            parentType: params.parentType as "page_id" | "block_id" | undefined,
            discussionId:
              (params.discussionId as string | undefined) ??
              (params.parentId as string | undefined),
          });
          if (!result.ok) {
            throw mapNotionError(result.error);
          }
          return { ok: true, data: { comment: result.data } };
        },
      }),
      { name: "notion_create_comment", optional: true },
    );

    api.registerTool(
      () => ({
        name: "notion_update_comment",
        label: "Notion Update Comment",
        description: "Modify an existing comment. This is a write operation.",
        parameters: {
          type: "object",
          properties: {
            commentId: { type: "string" },
            richText: { type: "array" },
          },
          required: ["commentId", "richText"],
        },
        async execute(params) {
          const result = await notionClient.updateComment(
            params.commentId as string,
            params.richText as unknown[],
          );
          if (!result.ok) {
            throw mapNotionError(result.error);
          }
          return { ok: true, data: { comment: result.data } };
        },
      }),
      { name: "notion_update_comment", optional: true },
    );

    // Phase 5: Advanced search
    api.registerTool(
      () => ({
        name: "notion_advanced_search",
        label: "Notion Advanced Search",
        description: "Advanced search with filters, sorting, and pagination support.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            filter: { type: "object" },
            sort: { type: "object" },
            pageSize: { type: "number" },
            cursor: { type: "string" },
          },
          required: ["query"],
        },
        async execute(params) {
          const result = await notionClient.advancedSearch(
            params.query as string,
            params.filter,
            params.sort,
            params.pageSize as number,
            params.cursor as string,
          );
          if (!result.ok) {
            throw mapNotionError(result.error);
          }
          return { ok: true, data: result.data };
        },
      }),
      { name: "notion_advanced_search", optional: true },
    );
  },
});

export default notionPlugin;
