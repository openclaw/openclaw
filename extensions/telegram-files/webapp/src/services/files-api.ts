/** HTTP REST client for the file system API. */

export type FileItem = {
  name: string;
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  mtime: number;
};

export type LsResult = {
  path: string;
  items: FileItem[];
};

export type ReadResult = {
  path: string;
  content: string;
  size: number;
};

export type SearchResult = {
  path: string;
  name: string;
  isDir: boolean;
};

export type SearchResponse = {
  path: string;
  query: string;
  results: SearchResult[];
};

export class FilesApiClient {
  private token: string;
  private baseUrl: string;

  constructor(token: string) {
    this.token = token;
    this.baseUrl = `${window.location.origin}/plugins/telegram-files/api`;
  }

  /** Parse response body and throw on non-ok status. */
  private async parseResponse(resp: Response): Promise<unknown> {
    let data: unknown;
    const contentType = resp.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      data = await resp.json();
    } else {
      const text = await resp.text();
      data = { error: text || `HTTP ${resp.status}` };
    }

    if (!resp.ok) {
      const errorObj = data as Record<string, unknown> | null;
      const message =
        errorObj && typeof errorObj.error === "string" ? errorObj.error : `HTTP ${resp.status}`;
      throw new Error(message);
    }
    return data;
  }

  private async request(method: string, endpoint: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    const opts: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const resp = await fetch(`${this.baseUrl}${endpoint}`, opts);
    return this.parseResponse(resp);
  }

  async ls(dirPath: string): Promise<LsResult> {
    const encoded = encodeURIComponent(dirPath);
    return (await this.request("GET", `/ls?path=${encoded}`)) as LsResult;
  }

  async read(filePath: string): Promise<ReadResult> {
    const encoded = encodeURIComponent(filePath);
    return (await this.request("GET", `/read?path=${encoded}`)) as ReadResult;
  }

  async write(filePath: string, content: string): Promise<void> {
    await this.request("POST", "/write", { path: filePath, content });
  }

  async delete(targetPath: string): Promise<void> {
    const encoded = encodeURIComponent(targetPath);
    await this.request("DELETE", `/delete?path=${encoded}`);
  }

  async mkdir(dirPath: string): Promise<void> {
    await this.request("POST", "/mkdir", { path: dirPath });
  }

  async home(): Promise<{ path: string }> {
    return (await this.request("GET", "/home")) as { path: string };
  }

  async upload(dirPath: string, file: File): Promise<void> {
    const encodedDir = encodeURIComponent(dirPath);
    const encodedName = encodeURIComponent(file.name);
    const resp = await fetch(`${this.baseUrl}/upload?dir=${encodedDir}&name=${encodedName}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
      body: file,
    });
    await this.parseResponse(resp);
  }

  async search(basePath: string, query: string): Promise<SearchResponse> {
    const encodedPath = encodeURIComponent(basePath);
    const encodedQuery = encodeURIComponent(query);
    return (await this.request(
      "GET",
      `/search?path=${encodedPath}&q=${encodedQuery}`,
    )) as SearchResponse;
  }
}
