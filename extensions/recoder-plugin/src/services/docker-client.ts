/**
 * Docker Backend API Client
 *
 * HTTP client for communicating with docker-backend (sandbox management).
 * Handles container lifecycle, file operations, and command execution.
 */

import type {
  RecoderPluginConfig,
  SandboxCreateRequest,
  SandboxResponse,
  SandboxState,
  FileInfo,
  FileReadResponse,
  FileWriteRequest,
  CommandExecuteRequest,
  CommandExecuteResponse,
} from "../types/index.js";

const DEFAULT_DOCKER_URL = "https://docker.recoder.xyz";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface DockerClientOptions {
  dockerUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export class DockerClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(options: DockerClientOptions = {}) {
    this.baseUrl = (options.dockerUrl ?? DEFAULT_DOCKER_URL).replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Create client from plugin config
   */
  static fromConfig(config: RecoderPluginConfig): DockerClient {
    return new DockerClient({
      dockerUrl: config.dockerUrl,
      apiKey: config.apiKey,
    });
  }

  /**
   * Create client with API key
   */
  static withApiKey(apiKey: string, config?: RecoderPluginConfig): DockerClient {
    return new DockerClient({
      dockerUrl: config?.dockerUrl,
      apiKey,
    });
  }

  /**
   * Build authorization headers
   */
  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers["X-API-Key"] = this.apiKey;
    }

    return headers;
  }

  /**
   * Make an HTTP request with error handling and retries
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { timeoutMs?: number; retries?: number },
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const maxRetries = options?.retries ?? 3;

    let lastError: unknown;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          method,
          headers: this.getAuthHeaders(),
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          let errorData: { error?: { code?: string; message?: string } } = {};
          try {
            errorData = JSON.parse(errorBody);
          } catch {
            // Not JSON
          }

          const code = errorData.error?.code ?? `HTTP_${response.status}`;
          const message = errorData.error?.message ?? response.statusText ?? "Request failed";

          // Don't retry 4xx errors (except 429)
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            throw { code, message, status: response.status };
          }

          // Check for rate limit retry-after header
          if (response.status === 429) {
            const retryAfter = response.headers.get("Retry-After");
            if (retryAfter && attempt < maxRetries - 1) {
              const waitMs = parseInt(retryAfter, 10) * 1000 || 1000;
              await new Promise((resolve) => setTimeout(resolve, waitMs));
              continue;
            }
          }

          throw { code, message, status: response.status };
        }

        // Handle empty responses
        const contentType = response.headers.get("content-type");
        if (contentType?.includes("application/json")) {
          return (await response.json()) as T;
        }
        return { success: true } as T;
      } catch (err: unknown) {
        clearTimeout(timeoutId);
        lastError = err;

        if (err instanceof Error && err.name === "AbortError") {
          lastError = { code: "TIMEOUT", message: `Request timed out after ${timeoutMs}ms` };
        }

        // Exponential backoff for retryable errors
        if (attempt < maxRetries - 1) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }

  // ==================== Sandbox Management ====================

  /**
   * Create a new sandbox
   */
  async createSandbox(request: SandboxCreateRequest): Promise<SandboxResponse> {
    return this.request("POST", "/api/v1/sandboxes", request, { timeoutMs: 60_000 });
  }

  /**
   * Get sandbox status
   */
  async getSandbox(sandboxId: string): Promise<SandboxResponse> {
    return this.request("GET", `/api/v1/sandboxes/${sandboxId}`);
  }

  /**
   * List all sandboxes
   */
  async listSandboxes(): Promise<{ sandboxes: SandboxResponse[] }> {
    return this.request("GET", "/api/v1/sandboxes");
  }

  /**
   * Start a stopped sandbox
   */
  async startSandbox(sandboxId: string): Promise<SandboxResponse> {
    return this.request("POST", `/api/v1/sandboxes/${sandboxId}/start`);
  }

  /**
   * Stop a running sandbox
   */
  async stopSandbox(sandboxId: string): Promise<SandboxResponse> {
    return this.request("POST", `/api/v1/sandboxes/${sandboxId}/stop`);
  }

  /**
   * Restart a sandbox
   */
  async restartSandbox(sandboxId: string): Promise<SandboxResponse> {
    return this.request("POST", `/api/v1/sandboxes/${sandboxId}/restart`);
  }

  /**
   * Delete a sandbox
   */
  async deleteSandbox(sandboxId: string): Promise<{ success: boolean }> {
    return this.request("DELETE", `/api/v1/sandboxes/${sandboxId}`);
  }

  // ==================== File Operations ====================

  /**
   * List files in a sandbox directory
   */
  async listFiles(sandboxId: string, dirPath: string = "/"): Promise<{ files: FileInfo[] }> {
    const encodedPath = encodeURIComponent(dirPath);
    return this.request("GET", `/api/v1/sandboxes/${sandboxId}/files?path=${encodedPath}`);
  }

  /**
   * Read a file from sandbox
   */
  async readFile(sandboxId: string, filePath: string): Promise<FileReadResponse> {
    const encodedPath = encodeURIComponent(filePath);
    return this.request("GET", `/api/v1/sandboxes/${sandboxId}/files/read?path=${encodedPath}`);
  }

  /**
   * Write a file to sandbox
   */
  async writeFile(
    sandboxId: string,
    request: FileWriteRequest,
  ): Promise<{ success: boolean; path: string }> {
    return this.request("POST", `/api/v1/sandboxes/${sandboxId}/files/write`, request);
  }

  /**
   * Delete a file from sandbox
   */
  async deleteFile(sandboxId: string, filePath: string): Promise<{ success: boolean }> {
    const encodedPath = encodeURIComponent(filePath);
    return this.request("DELETE", `/api/v1/sandboxes/${sandboxId}/files?path=${encodedPath}`);
  }

  /**
   * Write multiple files at once
   */
  async writeFiles(
    sandboxId: string,
    files: Array<{ path: string; content: string }>,
  ): Promise<{ success: boolean; results: Array<{ path: string; success: boolean }> }> {
    return this.request("POST", `/api/v1/sandboxes/${sandboxId}/files/batch`, { files });
  }

  // ==================== Command Execution ====================

  /**
   * Execute a command in sandbox
   */
  async executeCommand(
    sandboxId: string,
    request: CommandExecuteRequest,
  ): Promise<CommandExecuteResponse> {
    const timeoutMs = request.timeoutMs ?? 30_000;
    return this.request("POST", `/api/v1/sandboxes/${sandboxId}/exec`, request, {
      timeoutMs: timeoutMs + 5000, // Add buffer for network latency
    });
  }

  /**
   * Execute a shell command (convenience method)
   */
  async shell(
    sandboxId: string,
    command: string,
    options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<CommandExecuteResponse> {
    return this.executeCommand(sandboxId, {
      command,
      cwd: options?.cwd,
      env: options?.env,
      timeoutMs: options?.timeoutMs,
    });
  }

  // ==================== Dev Server ====================

  /**
   * Start the dev server in sandbox
   */
  async startDevServer(sandboxId: string): Promise<{ previewUrl: string }> {
    return this.request("POST", `/api/v1/sandboxes/${sandboxId}/dev-server/start`);
  }

  /**
   * Stop the dev server
   */
  async stopDevServer(sandboxId: string): Promise<{ success: boolean }> {
    return this.request("POST", `/api/v1/sandboxes/${sandboxId}/dev-server/stop`);
  }

  /**
   * Get dev server status
   */
  async getDevServerStatus(sandboxId: string): Promise<{
    running: boolean;
    previewUrl?: string;
    port?: number;
  }> {
    return this.request("GET", `/api/v1/sandboxes/${sandboxId}/dev-server/status`);
  }

  // ==================== Preview ====================

  /**
   * Get preview URL for a sandbox
   */
  getPreviewUrl(sandboxId: string): string {
    return `${this.baseUrl}/preview/${sandboxId}`;
  }

  // ==================== Health ====================

  /**
   * Health check
   */
  async healthCheck(): Promise<{ status: string; containers?: number }> {
    try {
      const response = await this.request<{ status: string; containers?: number }>(
        "GET",
        "/health",
        undefined,
        { timeoutMs: 5000, retries: 1 },
      );
      return response;
    } catch {
      return { status: "unhealthy" };
    }
  }
}
