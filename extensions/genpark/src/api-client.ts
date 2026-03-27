/**
 * GenPark API Client
 *
 * Typed client for GenPark Circle and Marketplace REST APIs.
 * Handles authentication, error handling, and rate-limit retries.
 *
 * NOTE FOR GENPARK ENGINEERS:
 * The base URL and endpoint paths below are modeled on typical GenPark patterns.
 * Adjust `GENPARK_API_BASE` and individual method paths to match the actual API.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GENPARK_API_BASE = "https://api.genpark.ai/v1";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Zod Schemas — response validation
// ---------------------------------------------------------------------------

export const CircleMessageSchema = z.object({
  id: z.string(),
  circleId: z.string(),
  threadId: z.string().optional(),
  authorId: z.string(),
  authorName: z.string(),
  content: z.string(),
  createdAt: z.string(),
  attachments: z
    .array(
      z.object({
        url: z.string(),
        mimeType: z.string().optional(),
        filename: z.string().optional(),
      }),
    )
    .optional(),
});

export const CircleThreadSchema = z.object({
  id: z.string(),
  circleId: z.string(),
  title: z.string().optional(),
  messages: z.array(CircleMessageSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});

export const SkillSearchResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  author: z.string().optional(),
  version: z.string().optional(),
  downloads: z.number().optional(),
  tags: z.array(z.string()).optional(),
  installCommand: z.string().optional(),
  url: z.string().optional(),
});

export const UserProfileSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string().optional(),
  avatarUrl: z.string().optional(),
  bio: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CircleMessage = z.infer<typeof CircleMessageSchema>;
export type CircleThread = z.infer<typeof CircleThreadSchema>;
export type SkillSearchResult = z.infer<typeof SkillSearchResultSchema>;
export type UserProfile = z.infer<typeof UserProfileSchema>;

export interface GenParkClientConfig {
  apiToken: string;
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// API Error
// ---------------------------------------------------------------------------

export class GenParkApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
  ) {
    super(`GenPark API ${status} ${statusText}: ${body}`);
    this.name = "GenParkApiError";
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class GenParkClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: GenParkClientConfig) {
    this.baseUrl = config.baseUrl ?? GENPARK_API_BASE;
    this.headers = {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
      "User-Agent": "OpenClaw-GenPark-Extension/1.0",
    };
  }

  // -----------------------------------------------------------------------
  // Core HTTP with retry
  // -----------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    schema?: z.ZodType<T>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          headers: this.headers,
          body: body ? JSON.stringify(body) : undefined,
        });

        if (!res.ok) {
          const text = await res.text();
          const err = new GenParkApiError(res.status, res.statusText, text);

          // Retry on rate limit with exponential backoff
          if (err.isRateLimited && attempt < MAX_RETRIES - 1) {
            const retryAfter =
              Number(res.headers.get("retry-after")) || RETRY_DELAY_MS / 1000;
            await this.sleep(retryAfter * 1000 * (attempt + 1));
            lastError = err;
            continue;
          }

          throw err;
        }

        const json = await res.json();
        if (schema) {
          return schema.parse(json);
        }
        return json as T;
      } catch (err) {
        if (err instanceof GenParkApiError) throw err;
        lastError = err as Error;
        if (attempt < MAX_RETRIES - 1) {
          await this.sleep(RETRY_DELAY_MS * (attempt + 1));
        }
      }
    }

    throw lastError ?? new Error("GenPark API request failed after retries");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // -----------------------------------------------------------------------
  // Circle API
  // -----------------------------------------------------------------------

  /** Post a message to a GenPark Circle thread. */
  async postCircleMessage(
    circleId: string,
    threadId: string,
    content: string,
  ): Promise<CircleMessage> {
    return this.request(
      "POST",
      `/circles/${circleId}/threads/${threadId}/messages`,
      { content },
      CircleMessageSchema,
    );
  }

  /** Create a new thread in a GenPark Circle. */
  async createCircleThread(
    circleId: string,
    title: string,
    content: string,
  ): Promise<CircleThread> {
    return this.request(
      "POST",
      `/circles/${circleId}/threads`,
      { title, content },
      CircleThreadSchema,
    );
  }

  /** Get a Circle thread and its messages. */
  async getCircleThread(
    circleId: string,
    threadId: string,
  ): Promise<CircleThread> {
    return this.request(
      "GET",
      `/circles/${circleId}/threads/${threadId}`,
      undefined,
      CircleThreadSchema,
    );
  }

  // -----------------------------------------------------------------------
  // Marketplace / Skill API
  // -----------------------------------------------------------------------

  /** Search GenPark Skill Marketplace. */
  async searchSkills(
    query: string,
    options?: { page?: number; limit?: number; tags?: string[] },
  ): Promise<SkillSearchResult[]> {
    const params = new URLSearchParams({ q: query });
    if (options?.page) params.set("page", String(options.page));
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.tags?.length) params.set("tags", options.tags.join(","));

    return this.request(
      "GET",
      `/marketplace/skills?${params.toString()}`,
      undefined,
      z.array(SkillSearchResultSchema),
    );
  }

  // -----------------------------------------------------------------------
  // User API
  // -----------------------------------------------------------------------

  /** Get the authenticated user's profile (token validation). */
  async getMe(): Promise<UserProfile> {
    return this.request("GET", "/users/me", undefined, UserProfileSchema);
  }

  /** Get a user profile by ID. */
  async getUserProfile(userId: string): Promise<UserProfile> {
    return this.request(
      "GET",
      `/users/${userId}`,
      undefined,
      UserProfileSchema,
    );
  }
}
