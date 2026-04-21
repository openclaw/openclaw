// Notion API Client
// Implements HTTP requests to Notion API endpoints

const NOTION_API_VERSION = "2026-03-11";

interface NotionApiClientConfig {
  baseUrl: string;
  token: string;
}

export interface NotionApiSuccess<T> {
  ok: true;
  data: T;
}

export interface NotionApiError {
  ok: false;
  error: string;
}

export type NotionApiResponse<T> = NotionApiSuccess<T> | NotionApiError;

type NotionSearchKind = "page" | "data_source" | "all";
type NotionFetchTargetType = "auto" | "page" | "data_source";
type NotionPageParentInput = { type: "page" | "data_source"; id: string };
type NotionCommentParentType = "page_id" | "block_id";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNotionId(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) {
    return null;
  }

  const directId = extractNotionIdCandidate(trimmed);
  if (directId) {
    return directId;
  }

  try {
    const url = new URL(trimmed);
    return extractNotionIdCandidate(url.pathname);
  } catch {
    return null;
  }
}

function extractNotionIdCandidate(value: string): string | null {
  const matches = value.match(
    /[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
  );
  const candidate = matches?.at(-1);
  if (!candidate) {
    return null;
  }

  const compact = candidate.replace(/-/g, "");
  if (compact.length !== 32) {
    return null;
  }

  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ]
    .join("-")
    .toLowerCase();
}

function mapCreatePageParent(parent: NotionPageParentInput): Record<string, string> {
  return parent.type === "page" ? { page_id: parent.id } : { data_source_id: parent.id };
}

function buildDataSourcePropertiesPatch(
  addProperties?: unknown,
  renameProperties?: unknown[],
): Record<string, unknown> | undefined {
  const properties: Record<string, unknown> = {};

  if (isRecord(addProperties)) {
    Object.assign(properties, addProperties);
  }

  if (Array.isArray(renameProperties)) {
    for (const renameProperty of renameProperties) {
      if (!isRecord(renameProperty)) {
        continue;
      }
      const from = typeof renameProperty.from === "string" ? renameProperty.from : undefined;
      const to = typeof renameProperty.to === "string" ? renameProperty.to : undefined;
      if (!from || !to) {
        continue;
      }

      const existing = properties[from];
      properties[from] = isRecord(existing) ? { ...existing, name: to } : { name: to };
    }
  }

  return Object.keys(properties).length > 0 ? properties : undefined;
}

export class NotionApiClient {
  private config: NotionApiClientConfig;

  constructor(config: NotionApiClientConfig) {
    this.config = config;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<NotionApiResponse<T>> {
    const url = `${this.config.baseUrl}${endpoint}`;

    try {
      const response = await fetch(url, {
        ...options,
        headers: Object.assign(
          {
            Authorization: `Bearer ${this.config.token}`,
            "Notion-Version": NOTION_API_VERSION,
            "Content-Type": "application/json",
          },
          options.headers || {},
        ),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          ok: false as const,
          error: `Notion API error: ${response.status} ${response.statusText} - ${errorText}`,
        };
      }

      const data = await response.json();
      return {
        ok: true as const,
        data,
      };
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getBlock(blockId: string) {
    return this.request(`/blocks/${blockId}`);
  }

  async getBlockChildren(blockId: string, pageSize?: number, startCursor?: string) {
    const params = new URLSearchParams();
    if (pageSize) {
      params.append("page_size", String(pageSize));
    }
    if (startCursor) {
      params.append("start_cursor", startCursor);
    }

    return this.request(`/blocks/${blockId}/children?${params.toString()}`);
  }

  async appendBlockChildren(blockId: string, children: unknown[]) {
    return this.request(`/blocks/${blockId}/children`, {
      method: "PATCH",
      body: JSON.stringify({ children }),
    });
  }

  async updateBlock(blockId: string, block: unknown) {
    return this.request(`/blocks/${blockId}`, {
      method: "PATCH",
      body: JSON.stringify(block),
    });
  }

  async deleteBlock(blockId: string) {
    return this.request(`/blocks/${blockId}`, {
      method: "DELETE",
    });
  }

  async getDatabase(databaseId: string) {
    return this.request(`/databases/${databaseId}`);
  }

  async getDataSource(dataSourceId: string) {
    return this.request(`/data_sources/${dataSourceId}`);
  }

  async deletePage(pageId: string) {
    return this.request(`/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({ in_trash: true }),
    });
  }

  async search(query?: string, kind?: NotionSearchKind, pageSize?: number, cursor?: string) {
    const body: Record<string, unknown> = {};
    if (typeof query === "string" && query.length > 0) {
      body.query = query;
    }
    if (kind && kind !== "all") {
      body.filter = { property: "object", value: kind };
    }
    if (pageSize) body.page_size = pageSize;
    if (cursor) body.start_cursor = cursor;

    return this.request("/search", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async fetchPage(
    target: string,
    targetType: NotionFetchTargetType = "auto",
    includeBlocks?: boolean,
    blockPageSize?: number,
    blockCursor?: string,
  ) {
    const normalizedId = normalizeNotionId(target);
    if (!normalizedId) {
      return {
        ok: false as const,
        error: `Invalid Notion page or data source target: ${target}`,
      };
    }

    if (targetType === "data_source") {
      return this.fetchDataSourceTarget(target, normalizedId);
    }

    if (targetType === "page") {
      return this.fetchPageById(normalizedId, includeBlocks, blockPageSize, blockCursor);
    }

    const page = await this.fetchPageById(normalizedId, includeBlocks, blockPageSize, blockCursor);
    if (page.ok) {
      return page;
    }

    const dataSource = await this.fetchDataSourceTarget(target, normalizedId);
    if (dataSource.ok) {
      return dataSource;
    }

    return {
      ok: false as const,
      error: `${page.error}; ${dataSource.error}`,
    };
  }

  private async fetchPageById(
    pageId: string,
    includeBlocks?: boolean,
    blockPageSize?: number,
    blockCursor?: string,
  ) {
    const page = await this.request(`/pages/${pageId}`);
    if (!page.ok) {
      return page;
    }

    if (includeBlocks) {
      const children = await this.getBlockChildren(pageId, blockPageSize, blockCursor);
      return {
        ok: true as const,
        data: Object.assign({}, page.data as Record<string, unknown>, {
          children: children.ok ? children.data : [],
        }),
      };
    }

    return page;
  }

  private async fetchDataSourceTarget(target: string, normalizedId: string) {
    const direct = await this.getDataSource(normalizedId);
    if (direct.ok) {
      return direct;
    }

    const database = await this.getDatabase(normalizedId);
    if (!database.ok) {
      return direct;
    }

    const dataSources = Array.isArray((database.data as Record<string, unknown>)?.data_sources)
      ? ((database.data as Record<string, unknown>).data_sources as unknown[])
      : [];
    const ids = dataSources
      .map((entry) => (isRecord(entry) && typeof entry.id === "string" ? entry.id : undefined))
      .filter((value): value is string => typeof value === "string");

    if (ids.length === 1) {
      return this.getDataSource(ids[0]);
    }

    return {
      ok: false as const,
      error:
        ids.length === 0
          ? `Could not resolve a data source from target: ${target}`
          : `Notion URL resolves to a database with multiple data sources. Pass a data source ID instead: ${target}`,
    };
  }

  async queryDataSource(
    dataSourceId: string,
    filter?: unknown,
    sorts?: unknown[],
    pageSize?: number,
    cursor?: string,
  ) {
    const body: Record<string, unknown> = {};
    if (filter) {
      body.filter = filter;
    }
    if (sorts) {
      body.sorts = sorts;
    }
    if (pageSize) {
      body.page_size = pageSize;
    }
    if (cursor) {
      body.start_cursor = cursor;
    }

    return this.request(`/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async createPage(
    parent: NotionPageParentInput,
    properties: unknown,
    content?: unknown[],
    icon?: unknown,
    cover?: unknown,
  ) {
    const body: Record<string, unknown> = {
      parent: mapCreatePageParent(parent),
      properties,
    };
    if (content) {
      body.children = content;
    }
    if (icon) {
      body.icon = icon;
    }
    if (cover) {
      body.cover = cover;
    }

    return this.request("/pages", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async updatePage(
    pageId: string,
    properties?: unknown,
    appendContent?: unknown[],
    icon?: unknown,
    cover?: unknown,
    eraseContent?: boolean,
    archive?: boolean,
    restore?: boolean,
  ) {
    const body: Record<string, unknown> = {};
    if (properties) body.properties = properties;
    if (icon) body.icon = icon;
    if (cover) body.cover = cover;
    if (eraseContent) body.erase_content = true;
    if (archive) body.in_trash = true;
    if (restore) body.in_trash = false;

    const pageResult = await this.request(`/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });

    if (!pageResult.ok || !appendContent) {
      return pageResult;
    }

    // Append blocks via separate endpoint
    return this.appendBlockChildren(pageId, appendContent);
  }

  async createDataSource(
    parentDatabaseId: string,
    title: string,
    properties?: unknown,
    icon?: unknown,
  ) {
    const body: Record<string, unknown> = {
      parent: { database_id: parentDatabaseId },
      title: [{ type: "text", text: { content: title } }],
      properties: properties || {},
    };
    if (icon) {
      body.icon = icon;
    }

    return this.request("/data_sources", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async updateDataSource(
    dataSourceId: string,
    title?: string,
    addProperties?: unknown,
    renameProperties?: unknown[],
    parentDatabaseId?: string,
    inTrash?: boolean,
    icon?: unknown,
  ) {
    const body: Record<string, unknown> = {};
    if (title) {
      body.title = [{ type: "text", text: { content: title } }];
    }
    const properties = buildDataSourcePropertiesPatch(addProperties, renameProperties);
    if (properties) {
      body.properties = properties;
    }
    if (parentDatabaseId) {
      body.parent = { database_id: parentDatabaseId };
    }
    if (inTrash !== undefined) {
      body.in_trash = inTrash;
    }
    if (icon) {
      body.icon = icon;
    }

    return this.request(`/data_sources/${dataSourceId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  // Phase 3: User operations
  async getUser(userId: string) {
    return this.request(`/users/${userId}`);
  }

  async listUsers() {
    return this.request("/users");
  }

  // Phase 4: Comment operations
  async getComments(blockId: string, pageSize?: number, startCursor?: string) {
    const params = new URLSearchParams();
    if (pageSize) {
      params.append("page_size", String(pageSize));
    }
    if (startCursor) {
      params.append("start_cursor", startCursor);
    }

    return this.request(`/comments?block_id=${blockId}&${params.toString()}`);
  }

  async createComment(params: {
    richText: unknown[];
    targetId?: string;
    parentType?: NotionCommentParentType;
    discussionId?: string;
  }) {
    const body: Record<string, unknown> = {
      rich_text: params.richText,
    };
    if (params.discussionId) {
      body.discussion_id = params.discussionId;
    } else if (params.targetId && params.parentType) {
      body.parent = { [params.parentType]: params.targetId };
    } else {
      return {
        ok: false as const,
        error: "Creating a comment requires either discussionId or both targetId and parentType.",
      };
    }

    return this.request("/comments", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async updateComment(commentId: string, richText: unknown[]) {
    return this.request(`/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify({ rich_text: richText }),
    });
  }

  // Phase 5: Advanced search
  async advancedSearch(
    query: string,
    filter?: unknown,
    sort?: unknown,
    pageSize?: number,
    startCursor?: string,
  ) {
    const body: Record<string, unknown> = { query };
    if (filter) {
      body.filter = filter;
    }
    if (sort) {
      body.sort = sort;
    }
    if (pageSize) {
      body.page_size = pageSize;
    }
    if (startCursor) {
      body.start_cursor = startCursor;
    }

    return this.request("/search", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}
