// Notion API Client
// Implements HTTP requests to Notion API endpoints

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

export class NotionApiClient {
  private config: NotionApiClientConfig;

  constructor(config: NotionApiClientConfig) {
    this.config = config;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<NotionApiResponse<T>> {
    const url = `${this.config.baseUrl}${endpoint}`;
    
    try {
      const response = await fetch(url, {
        ...options,
        headers: Object.assign(
          {
            'Authorization': `Bearer ${this.config.token}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json',
          },
          options.headers || {}
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
    if (pageSize) {params.append('page_size', String(pageSize));}
    if (startCursor) {params.append('start_cursor', startCursor);}
    
    return this.request(`/blocks/${blockId}/children?${params.toString()}`);
  }

  async appendBlockChildren(blockId: string, children: unknown[]) {
    return this.request(`/blocks/${blockId}/children`, {
      method: 'PATCH',
      body: JSON.stringify({ children }),
    });
  }

  async updateBlock(blockId: string, block: unknown) {
    return this.request(`/blocks/${blockId}`, {
      method: 'PATCH',
      body: JSON.stringify(block),
    });
  }

  async deleteBlock(blockId: string) {
    return this.request(`/blocks/${blockId}`, {
      method: 'DELETE',
    });
  }

  async getDatabase(databaseId: string) {
    return this.request(`/databases/${databaseId}`);
  }

  async deletePage(pageId: string) {
    return this.request(`/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived: true }),
    });
  }

  async search(query: string, kind?: string, pageSize?: number, cursor?: string) {
    const params = new URLSearchParams();
    params.append('query', query);
    if (kind) {params.append('filter', JSON.stringify({ property: 'object', value: kind }));}
    if (pageSize) {params.append('page_size', String(pageSize));}
    if (cursor) {params.append('start_cursor', cursor);}
    
    return this.request(`/search?${params.toString()}`);
  }

  async fetchPage(pageId: string, includeBlocks?: boolean) {
    const page = await this.request(`/pages/${pageId}`);
    if (!page.ok) {return page;}
    
    if (includeBlocks) {
      const children = await this.getBlockChildren(pageId);
      return {
        ok: true as const,
        data: Object.assign({}, page.data as Record<string, unknown>, { children: children.ok ? children.data : [] }),
      };
    }
    
    return page;
  }

  async queryDataSource(dataSourceId: string, filter?: unknown, sorts?: unknown[], pageSize?: number, cursor?: string) {
    const params = new URLSearchParams();
    if (pageSize) {params.append('page_size', String(pageSize));}
    if (cursor) {params.append('start_cursor', cursor);}
    
    const body: Record<string, unknown> = {};
    if (filter) {body.filter = filter;}
    if (sorts) {body.sorts = sorts;}
    
    return this.request(`/databases/${dataSourceId}/query?${params.toString()}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async createPage(parent: { type: string; id: string }, properties: unknown, content?: unknown[], icon?: unknown, cover?: unknown) {
    const body: Record<string, unknown> = {
      parent,
      properties,
    };
    if (content) {body.children = content;}
    if (icon) {body.icon = icon;}
    if (cover) {body.cover = cover;}
    
    return this.request('/pages', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async updatePage(pageId: string, properties?: unknown, appendContent?: unknown[], icon?: unknown, cover?: unknown, eraseContent?: boolean, archive?: boolean, restore?: boolean) {
    const body: Record<string, unknown> = {};
    if (properties) body.properties = properties;
    if (icon) body.icon = icon;
    if (cover) body.cover = cover;
    if (archive) body.archived = true;
    if (restore) body.archived = false;
    
    const pageResult = await this.request(`/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });

    if (!pageResult.ok || !appendContent) {
      return pageResult;
    }

    // Append blocks via separate endpoint
    return this.appendBlockChildren(pageId, appendContent);
  }

  async createDataSource(parentDatabaseId: string, title: string, description?: string, properties?: unknown, icon?: unknown) {
    const body: Record<string, unknown> = {
      parent: { type: 'database_id', database_id: parentDatabaseId },
      title: [{ type: 'text', text: { content: title } }],
      properties: properties || {},
    };
    if (description) {body.description = description;}
    if (icon) {body.icon = icon;}
    
    return this.request('/databases', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async updateDataSource(dataSourceId: string, title?: string, description?: string, addProperties?: unknown, renameProperties?: unknown[], parentDatabaseId?: string, inTrash?: boolean, icon?: unknown) {
    const body: Record<string, unknown> = {};
    if (title) {body.title = [{ type: 'text', text: { content: title } }];}
    if (description) {body.description = description;}
    if (addProperties) {body.properties = addProperties;}
    if (renameProperties) {body.rename_properties = renameProperties;}
    if (parentDatabaseId) {body.parent = { type: 'database_id', database_id: parentDatabaseId };}
    if (inTrash !== undefined) {body.archived = inTrash;}
    if (icon) {body.icon = icon;}
    
    return this.request(`/databases/${dataSourceId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  // Phase 3: User operations
  async getUser(userId: string) {
    return this.request(`/users/${userId}`);
  }

  async listUsers() {
    return this.request('/users');
  }

  // Phase 4: Comment operations
  async getComments(blockId: string, pageSize?: number, startCursor?: string) {
    const params = new URLSearchParams();
    if (pageSize) {params.append('page_size', String(pageSize));}
    if (startCursor) {params.append('start_cursor', startCursor);}
    
    return this.request(`/comments?block_id=${blockId}&${params.toString()}`);
  }

  async createComment(blockId: string, richText: unknown[], parentId?: string, parentType: 'page_id' | 'block_id' = 'block_id') {
    const body: Record<string, unknown> = {
      parent: { type: parentType, [parentType]: blockId },
      rich_text: richText,
    };
    if (parentId) body.parent_id = parentId;
    
    return this.request('/comments', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async updateComment(commentId: string, richText: unknown[]) {
    return this.request(`/comments/${commentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ rich_text: richText }),
    });
  }

  // Phase 5: Advanced search
  async advancedSearch(query: string, filter?: unknown, sort?: unknown, pageSize?: number, startCursor?: string) {
    const params = new URLSearchParams();
    params.append('query', query);
    if (pageSize) {params.append('page_size', String(pageSize));}
    if (startCursor) {params.append('start_cursor', startCursor);}
    
    const body: Record<string, unknown> = {};
    if (filter) {body.filter = filter;}
    if (sort) {body.sort = sort;}
    
    const queryString = params.toString();
    const bodyString = Object.keys(body).length > 0 ? JSON.stringify(body) : undefined;
    
    return this.request(`/search?${queryString}`, {
      method: 'POST',
      body: bodyString,
    });
  }
}
