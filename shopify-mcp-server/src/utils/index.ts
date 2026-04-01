/**
 * Utility functions for Shopify Admin MCP Server
 *
 * This module provides common utility functions for GraphQL operations,
 * error handling, data transformation, and other shared functionality.
 */

import {
  GraphQLResponse,
  ShopifyError,
  UserError,
  MCPResult,
  PaginationParams,
  Connection,
  Edge,
  PageInfo,
  ShopifyAPIError,
  MCPToolError,
  RateLimitError,
  RateLimitInfo,
  hasGraphQLErrors,
  hasConnectionData,
  validators,
  COMMON_FIELDS,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
} from "@/types/index.js";

// ============================================================================
// GraphQL Utilities
// ============================================================================

/**
 * Build a GraphQL query string with proper formatting
 */
export function buildGraphQLQuery(
  operation: "query" | "mutation",
  name: string,
  variables: Record<string, string> = {},
  fields: string,
): string {
  const variableDefinitions = Object.entries(variables)
    .map(([key, type]) => `$${key}: ${type}`)
    .join(", ");

  const variableList = variableDefinitions ? `(${variableDefinitions})` : "";

  return `
    ${operation} ${name}${variableList} {
      ${fields}
    }
  `.trim();
}

/**
 * Build pagination arguments for GraphQL queries
 */
export function buildPaginationArgs(params: PaginationParams = {}): string {
  const args: string[] = [];

  if (params.first !== undefined) {
    args.push(`first: ${Math.min(params.first, MAX_PAGE_SIZE)}`);
  } else if (params.last !== undefined) {
    args.push(`last: ${Math.min(params.last, MAX_PAGE_SIZE)}`);
  } else {
    args.push(`first: ${DEFAULT_PAGE_SIZE}`);
  }

  if (params.after) {
    args.push(`after: "${params.after}"`);
  }

  if (params.before) {
    args.push(`before: "${params.before}"`);
  }

  return args.length > 0 ? `(${args.join(", ")})` : "";
}

/**
 * Build search query arguments
 */
export function buildSearchArgs(query?: string, sortKey?: string, reverse?: boolean): string {
  const args: string[] = [];

  if (query) {
    args.push(`query: "${escapeGraphQLString(query)}"`);
  }

  if (sortKey) {
    args.push(`sortKey: ${sortKey}`);
  }

  if (reverse !== undefined) {
    args.push(`reverse: ${reverse}`);
  }

  return args.length > 0 ? `, ${args.join(", ")}` : "";
}

/**
 * Escape special characters in GraphQL strings
 */
export function escapeGraphQLString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Extract nodes from a GraphQL connection
 */
export function extractNodes<T>(connection: Connection<T> | null | undefined): T[] {
  if (!connection || !hasConnectionData(connection)) {
    return [];
  }

  return connection.edges.map((edge) => edge.node);
}

/**
 * Extract page info from a GraphQL connection
 */
export function extractPageInfo(connection: Connection<any> | null | undefined): PageInfo | null {
  if (!connection || !hasConnectionData(connection)) {
    return null;
  }

  return connection.pageInfo;
}

/**
 * Build a connection field query with pagination
 */
export function buildConnectionQuery(
  fieldName: string,
  nodeFields: string,
  params: PaginationParams = {},
  additionalArgs: string = "",
): string {
  const paginationArgs = buildPaginationArgs(params);
  const args = additionalArgs
    ? `${paginationArgs.slice(0, -1)}, ${additionalArgs})`
    : paginationArgs;

  return `
    ${fieldName}${args} {
      edges {
        cursor
        node {
          ${nodeFields}
        }
      }
      pageInfo {
        ${COMMON_FIELDS.PAGE_INFO}
      }
    }
  `;
}

// ============================================================================
// Error Handling Utilities
// ============================================================================

/**
 * Transform GraphQL errors into structured error objects
 */
export function transformGraphQLErrors(errors: ShopifyError[]): ShopifyAPIError[] {
  return errors.map(
    (error) =>
      new ShopifyAPIError(
        error.message,
        error.extensions?.code,
        error.path as string[],
        error.extensions,
      ),
  );
}

/**
 * Transform user errors into structured error objects
 */
export function transformUserErrors(userErrors: UserError[]): ShopifyAPIError[] {
  return userErrors.map((error) => new ShopifyAPIError(error.message, error.code, error.field));
}

/**
 * Create a standardized MCP result from a GraphQL response
 */
export function createMCPResult<T>(
  response: GraphQLResponse<T>,
  dataExtractor?: (data: T) => any,
): MCPResult<any> {
  // Check for GraphQL errors
  if (hasGraphQLErrors(response)) {
    const errors = transformGraphQLErrors(response.errors);
    return {
      success: false,
      error: errors.map((e) => e.message).join("; "),
      metadata: {
        cost: response.extensions?.cost,
      },
    };
  }

  // Check if we have data
  if (!response.data) {
    return {
      success: false,
      error: "No data returned from GraphQL query",
    };
  }

  // Extract the actual data
  const extractedData = dataExtractor ? dataExtractor(response.data) : response.data;

  return {
    success: true,
    data: extractedData,
    metadata: {
      cost: response.extensions?.cost,
    },
  };
}

/**
 * Handle rate limiting errors
 */
export function handleRateLimit(error: any): never {
  if (error.extensions?.code === "THROTTLED") {
    const rateLimitInfo: RateLimitInfo = {
      maximumAvailable: error.extensions.cost?.throttleStatus?.maximumAvailable || 0,
      currentlyAvailable: error.extensions.cost?.throttleStatus?.currentlyAvailable || 0,
      restoreRate: error.extensions.cost?.throttleStatus?.restoreRate || 50,
    };

    const retryAfter = Math.ceil(
      (error.extensions.cost?.requestedQueryCost || 0) / rateLimitInfo.restoreRate,
    );

    throw new RateLimitError(
      `Rate limit exceeded. Retry after ${retryAfter} seconds.`,
      retryAfter,
      rateLimitInfo,
    );
  }

  throw error;
}

/**
 * Retry function with exponential backoff
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000,
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      // Don't retry on certain types of errors
      if (error instanceof ShopifyAPIError && error.code === "INVALID_CREDENTIALS") {
        throw error;
      }

      // If this is the last attempt, throw the error
      if (attempt === maxRetries) {
        throw error;
      }

      // Calculate delay with exponential backoff
      const delay = baseDelay * Math.pow(2, attempt);
      await sleep(delay);
    }
  }

  throw lastError!;
}

/**
 * Sleep utility function
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Data Transformation Utilities
// ============================================================================

/**
 * Convert Shopify money object to formatted string
 */
export function formatMoney(money: { amount: string; currencyCode: string }): string {
  const amount = parseFloat(money.amount);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: money.currencyCode,
  }).format(amount);
}

/**
 * Convert Shopify date string to Date object
 */
export function parseShopifyDate(dateString: string): Date {
  return new Date(dateString);
}

/**
 * Format date for display
 */
export function formatDate(date: Date | string, options: Intl.DateTimeFormatOptions = {}): string {
  const dateObj = typeof date === "string" ? new Date(date) : date;

  const defaultOptions: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  };

  return new Intl.DateTimeFormat("en-US", { ...defaultOptions, ...options }).format(dateObj);
}

/**
 * Sanitize HTML content
 */
export function sanitizeHTML(html: string): string {
  // Basic HTML sanitization - remove script tags and dangerous attributes
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/on\w+="[^"]*"/gi, "")
    .replace(/javascript:/gi, "");
}

/**
 * Truncate text to specified length
 */
export function truncateText(text: string, maxLength: number, suffix: string = "..."): string {
  if (text.length <= maxLength) {
    return text;
  }

  return text.substring(0, maxLength - suffix.length) + suffix;
}

/**
 * Convert snake_case to camelCase
 */
export function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Convert camelCase to snake_case
 */
export function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Deep merge objects
 */
export function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key in source) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key] as any);
    } else {
      result[key] = source[key] as any;
    }
  }

  return result;
}

// ============================================================================
// Validation Utilities
// ============================================================================

/**
 * Validate and normalize pagination parameters
 */
export function validatePagination(params: PaginationParams): PaginationParams {
  if (!validators.isValidPagination(params)) {
    throw new MCPToolError("Invalid pagination parameters", "validatePagination");
  }

  const normalized: PaginationParams = {};

  if (params.first !== undefined) {
    normalized.first = Math.min(Math.max(params.first, 1), MAX_PAGE_SIZE);
  }

  if (params.last !== undefined) {
    normalized.last = Math.min(Math.max(params.last, 1), MAX_PAGE_SIZE);
  }

  if (params.after) {
    normalized.after = params.after;
  }

  if (params.before) {
    normalized.before = params.before;
  }

  return normalized;
}

/**
 * Validate Shopify ID format
 */
export function validateShopifyId(id: string, resourceType?: string): string {
  if (!validators.isValidShopifyId(id)) {
    throw new MCPToolError(
      `Invalid Shopify ID format: ${id}. Expected format: gid://shopify/ResourceType/123`,
      "validateShopifyId",
    );
  }

  if (resourceType) {
    const expectedPrefix = `gid://shopify/${resourceType}/`;
    if (!id.startsWith(expectedPrefix)) {
      throw new MCPToolError(
        `Invalid resource type in ID: ${id}. Expected ${resourceType}`,
        "validateShopifyId",
      );
    }
  }

  return id;
}

/**
 * Extract numeric ID from Shopify GID
 */
export function extractNumericId(gid: string): string {
  validateShopifyId(gid);
  return gid.split("/").pop() || "";
}

/**
 * Create Shopify GID from numeric ID and resource type
 */
export function createShopifyId(resourceType: string, numericId: string | number): string {
  return `gid://shopify/${resourceType}/${numericId}`;
}

// ============================================================================
// Performance Utilities
// ============================================================================

/**
 * Performance timer for measuring operation duration
 */
export class PerformanceTimer {
  private startTime: number;
  private endTime?: number;

  constructor(private operation: string) {
    this.startTime = performance.now();
  }

  /**
   * Stop the timer and return duration
   */
  stop(): number {
    this.endTime = performance.now();
    return this.duration;
  }

  /**
   * Get duration in milliseconds
   */
  get duration(): number {
    const end = this.endTime || performance.now();
    return end - this.startTime;
  }

  /**
   * Log performance information
   */
  log(logger?: (message: string) => void): void {
    const duration = this.endTime ? this.duration : this.duration;
    const message = `${this.operation} completed in ${duration.toFixed(2)}ms`;

    if (logger) {
      logger(message);
    } else {
      console.log(message);
    }
  }
}

/**
 * Measure async operation performance
 */
export async function measurePerformance<T>(
  operation: () => Promise<T>,
  operationName: string,
  logger?: (message: string) => void,
): Promise<T> {
  const timer = new PerformanceTimer(operationName);

  try {
    const result = await operation();
    timer.stop();
    timer.log(logger);
    return result;
  } catch (error) {
    timer.stop();
    timer.log(logger);
    throw error;
  }
}

// ============================================================================
// Caching Utilities
// ============================================================================

/**
 * Simple in-memory cache with TTL
 */
export class SimpleCache<T> {
  private cache = new Map<string, { value: T; expires: number }>();

  constructor(private defaultTTL: number = 300000) {} // 5 minutes default

  /**
   * Get value from cache
   */
  get(key: string): T | undefined {
    const item = this.cache.get(key);

    if (!item) {
      return undefined;
    }

    if (Date.now() > item.expires) {
      this.cache.delete(key);
      return undefined;
    }

    return item.value;
  }

  /**
   * Set value in cache
   */
  set(key: string, value: T, ttl?: number): void {
    const expires = Date.now() + (ttl || this.defaultTTL);
    this.cache.set(key, { value, expires });
  }

  /**
   * Delete value from cache
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all cached values
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache size
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Clean up expired entries
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      if (now > item.expires) {
        this.cache.delete(key);
      }
    }
  }
}

// ============================================================================
// Export all utilities
// ============================================================================

export * from "./graphql.js";
export * from "./logger.js";
export * from "./rate-limiter.js";
