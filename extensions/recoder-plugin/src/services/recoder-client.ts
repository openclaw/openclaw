/**
 * Recoder Web API Client
 *
 * HTTP client for communicating with recoder-web (the main Recoder application).
 * Handles authentication, code generation requests, and project management.
 */

import type {
  ApiResponse,
  CodeGenerationRequest,
  CodeGenerationResponse,
  RecoderPluginConfig,
  RecoderError,
  RecoderErrorCode,
} from "../types/index.js";

const DEFAULT_WEB_URL = "https://web.recoder.xyz";
const DEFAULT_API_URL = "https://api.recoder.xyz";
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes for code generation

export interface RecoderClientOptions {
  webUrl?: string;
  apiUrl?: string;
  apiKey?: string;
  sessionCookie?: string;
  timeoutMs?: number;
}

export class RecoderClient {
  private readonly webUrl: string;
  private readonly apiUrl: string;
  private readonly apiKey?: string;
  private readonly sessionCookie?: string;
  private readonly timeoutMs: number;

  constructor(options: RecoderClientOptions = {}) {
    this.webUrl = (options.webUrl ?? DEFAULT_WEB_URL).replace(/\/$/, "");
    this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.sessionCookie = options.sessionCookie;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Create client from plugin config
   */
  static fromConfig(config: RecoderPluginConfig): RecoderClient {
    return new RecoderClient({
      webUrl: config.webUrl,
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
    });
  }

  /**
   * Create client with API key
   */
  static withApiKey(apiKey: string, config?: RecoderPluginConfig): RecoderClient {
    return new RecoderClient({
      webUrl: config?.webUrl,
      apiUrl: config?.apiUrl,
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
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    } else if (this.sessionCookie) {
      headers["Cookie"] = this.sessionCookie;
    }

    return headers;
  }

  /**
   * Make an HTTP request to API endpoint
   */
  private async apiRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    return this.doRequest(url, method, body, options);
  }

  /**
   * Make an HTTP request to web endpoint
   */
  private async webRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    const url = `${this.webUrl}${path}`;
    return this.doRequest(url, method, body, options);
  }

  /**
   * Make an HTTP request with error handling
   */
  private async doRequest<T>(
    url: string,
    method: string,
    body?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
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

        throw {
          code,
          message,
          status: response.status,
        };
      }

      const data = await response.json();
      return data as T;
    } catch (err: unknown) {
      clearTimeout(timeoutId);

      if (err instanceof Error && err.name === "AbortError") {
        throw {
          code: "TIMEOUT",
          message: `Request timed out after ${timeoutMs}ms`,
        };
      }

      throw err;
    }
  }

  /**
   * Stream code generation response
   * Returns a generator that yields chunks of the response
   */
  async *streamCodeGeneration(
    request: CodeGenerationRequest,
  ): AsyncGenerator<string, CodeGenerationResponse, unknown> {
    const url = `${this.webUrl}/api/chat`;
    const controller = new AbortController();
    const timeoutMs = this.timeoutMs;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Build the chat request payload
      const payload = {
        messages: [
          {
            role: "user",
            content: request.prompt,
          },
        ],
        provider: request.provider ?? "openrouter",
        model: request.model,
        maxTokens: request.maxTokens ?? 16000,
        projectId: request.projectId,
        codeContext: request.context,
      };

      const response = await fetch(url, {
        method: "POST",
        headers: this.getAuthHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw {
          code: `HTTP_${response.status}`,
          message: errorText || response.statusText,
        };
      }

      if (!response.body) {
        throw { code: "NO_BODY", message: "Response has no body" };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullResponse = "";
      const files: Array<{ path: string; content: string }> = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        fullResponse += chunk;
        yield chunk;
      }

      // Parse files from the response (look for recoderAction tags)
      const filePattern =
        /<recoderAction\s+type="file"\s+filePath="([^"]+)"[^>]*>([\s\S]*?)<\/recoderAction>/g;
      let match: RegExpExecArray | null;
      while ((match = filePattern.exec(fullResponse)) !== null) {
        files.push({
          path: match[1],
          content: match[2],
        });
      }

      // Also try reversed attribute order
      const filePatternAlt =
        /<recoderAction\s+filePath="([^"]+)"\s+type="file"[^>]*>([\s\S]*?)<\/recoderAction>/g;
      while ((match = filePatternAlt.exec(fullResponse)) !== null) {
        files.push({
          path: match[1],
          content: match[2],
        });
      }

      return {
        success: true,
        files,
        message: fullResponse,
      };
    } catch (err: unknown) {
      clearTimeout(timeoutId);

      if (err instanceof Error && err.name === "AbortError") {
        throw {
          code: "TIMEOUT",
          message: `Code generation timed out after ${timeoutMs}ms`,
        };
      }

      throw err;
    }
  }

  /**
   * Generate code (non-streaming)
   */
  async generateCode(request: CodeGenerationRequest): Promise<CodeGenerationResponse> {
    let fullResponse = "";
    const gen = this.streamCodeGeneration(request);

    // Consume the generator
    let result = await gen.next();
    while (!result.done) {
      fullResponse += result.value;
      result = await gen.next();
    }

    return result.value;
  }

  /**
   * Get project info
   */
  async getProject(projectId: string): Promise<{
    id: string;
    name: string;
    template: string;
    createdAt: number;
  }> {
    return this.apiRequest("GET", `/v1/projects/${projectId}`);
  }

  /**
   * List user's projects
   */
  async listProjects(): Promise<
    Array<{
      id: string;
      name: string;
      template: string;
      createdAt: number;
    }>
  > {
    const response = await this.apiRequest<{ projects: Array<any> }>("GET", "/v1/projects");
    return response.projects ?? [];
  }

  /**
   * Create a new project
   */
  async createProject(request: {
    name: string;
    template?: string;
  }): Promise<{ id: string; name: string }> {
    return this.apiRequest("POST", "/v1/projects", request);
  }

  /**
   * Delete a project
   */
  async deleteProject(projectId: string): Promise<{ success: boolean }> {
    return this.apiRequest("DELETE", `/v1/projects/${projectId}`);
  }

  /**
   * Health check - checks both web and API endpoints
   */
  async healthCheck(): Promise<{ status: string; webOk: boolean; apiOk: boolean }> {
    let webOk = false;
    let apiOk = false;

    try {
      const webResponse = await fetch(`${this.webUrl}/api/system-health`, {
        method: "GET",
        headers: this.getAuthHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      webOk = webResponse.ok;
    } catch {
      // Web unavailable
    }

    try {
      const apiResponse = await fetch(`${this.apiUrl}/health`, {
        method: "GET",
        headers: this.getAuthHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      apiOk = apiResponse.ok;
    } catch {
      // API unavailable
    }

    return {
      status: webOk && apiOk ? "healthy" : "unhealthy",
      webOk,
      apiOk,
    };
  }
}
