/**
 * Central type definitions index for Shopify Admin MCP Server
 *
 * This file exports all type definitions and provides utility types
 * for working with the Shopify Admin API.
 */

// Export all Shopify types
export * from "./shopify.js";

// ============================================================================
// Utility Types
// ============================================================================

/** Extract the node type from a Connection */
export type NodeType<T> = T extends { edges: Array<{ node: infer U }> } ? U : never;

/** Make all properties optional recursively */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/** Make specific properties required */
export type RequireFields<T, K extends keyof T> = T & Required<Pick<T, K>>;

/** Extract ID type from Shopify resources */
export type ShopifyId<T extends { id: string }> = T["id"];

/** Pagination parameters for GraphQL queries */
export interface PaginationParams {
  /** Number of items to fetch (max 250) */
  first?: number;
  /** Cursor to start after */
  after?: string;
  /** Number of items to fetch from the end (max 250) */
  last?: number;
  /** Cursor to start before */
  before?: string;
}

/** Common query parameters */
export interface QueryParams extends PaginationParams {
  /** Query string for searching */
  query?: string;
  /** Sort key */
  sortKey?: string;
  /** Reverse sort order */
  reverse?: boolean;
}

/** MCP tool result wrapper */
export interface MCPResult<T = any> {
  /** Whether the operation was successful */
  success: boolean;
  /** Result data */
  data?: T;
  /** Error message if operation failed */
  error?: string;
  /** Additional metadata */
  metadata?: {
    /** Query cost information */
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number;
      throttleStatus: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
    /** Pagination info */
    pageInfo?: {
      hasNextPage: boolean;
      hasPreviousPage: boolean;
      startCursor?: string;
      endCursor?: string;
    };
    /** Total count if available */
    totalCount?: number;
  };
}

/** Configuration for MCP tools */
export interface MCPToolConfig {
  /** Maximum number of retries for failed requests */
  maxRetries?: number;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Whether to include cost information in responses */
  includeCost?: boolean;
  /** Default pagination size */
  defaultPageSize?: number;
}

/** Shopify API rate limit information */
export interface RateLimitInfo {
  /** Maximum available points */
  maximumAvailable: number;
  /** Currently available points */
  currentlyAvailable: number;
  /** Points restored per second */
  restoreRate: number;
  /** Estimated time until full restore (seconds) */
  estimatedTimeToRestore?: number;
}

/** Bulk operation progress */
export interface BulkOperationProgress {
  /** Operation ID */
  id: string;
  /** Current status */
  status: string;
  /** Progress percentage (0-100) */
  progress: number;
  /** Objects processed */
  objectsProcessed: number;
  /** Total objects */
  totalObjects: number;
  /** Estimated completion time */
  estimatedCompletion?: string;
}

// ============================================================================
// Type Guards
// ============================================================================

/** Type guard to check if a value is a Shopify resource */
export function isShopifyResource(
  value: any,
): value is { id: string; createdAt: string; updatedAt: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.id === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

/** Type guard to check if a response has errors */
export function hasGraphQLErrors(
  response: any,
): response is { errors: Array<{ message: string }> } {
  return (
    typeof response === "object" &&
    response !== null &&
    Array.isArray(response.errors) &&
    response.errors.length > 0
  );
}

/** Type guard to check if a connection has data */
export function hasConnectionData<T>(
  connection: any,
): connection is { edges: Array<{ node: T; cursor: string }>; pageInfo: any } {
  return (
    typeof connection === "object" &&
    connection !== null &&
    Array.isArray(connection.edges) &&
    typeof connection.pageInfo === "object"
  );
}

// ============================================================================
// Constants
// ============================================================================

/** Shopify GraphQL API version */
export const SHOPIFY_API_VERSION = "2024-04";

/** Maximum items per page for GraphQL queries */
export const MAX_PAGE_SIZE = 250;

/** Default page size for queries */
export const DEFAULT_PAGE_SIZE = 50;

/** GraphQL query cost limits */
export const QUERY_COST_LIMITS = {
  /** Maximum cost per query */
  MAX_QUERY_COST: 1000,
  /** Maximum cost per second */
  MAX_COST_PER_SECOND: 50,
  /** Restore rate (points per second) */
  RESTORE_RATE: 50,
} as const;

/** Common Shopify field selections */
export const COMMON_FIELDS = {
  /** Basic resource fields */
  RESOURCE: "id createdAt updatedAt",
  /** Money fields */
  MONEY: "amount currencyCode",
  /** Image fields */
  IMAGE: "id url altText width height",
  /** Address fields */
  ADDRESS: `
    id firstName lastName company address1 address2 
    city province provinceCode country countryCode zip phone
  `,
  /** SEO fields */
  SEO: "title description",
  /** Page info for pagination */
  PAGE_INFO: "hasNextPage hasPreviousPage startCursor endCursor",
} as const;

// ============================================================================
// Error Types
// ============================================================================

/** Custom error class for Shopify API errors */
export class ShopifyAPIError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly field?: string[],
    public readonly extensions?: any,
  ) {
    super(message);
    this.name = "ShopifyAPIError";
  }
}

/** Custom error class for MCP tool errors */
export class MCPToolError extends Error {
  constructor(
    message: string,
    public readonly tool: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "MCPToolError";
  }
}

/** Custom error class for rate limit errors */
export class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfter: number,
    public readonly rateLimitInfo: RateLimitInfo,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

// ============================================================================
// Validation Schemas (for runtime validation)
// ============================================================================

/** Schema for validating Shopify IDs */
export const SHOPIFY_ID_PATTERN = /^gid:\/\/shopify\/\w+\/\d+$/;

/** Schema for validating email addresses */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Schema for validating phone numbers (basic) */
export const PHONE_PATTERN = /^\+?[\d\s\-()]+$/;

/** Schema for validating currency codes */
export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

/** Schema for validating country codes */
export const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

/** Validation helper functions */
export const validators = {
  /** Validate Shopify ID format */
  isValidShopifyId: (id: string): boolean => SHOPIFY_ID_PATTERN.test(id),

  /** Validate email format */
  isValidEmail: (email: string): boolean => EMAIL_PATTERN.test(email),

  /** Validate phone format */
  isValidPhone: (phone: string): boolean => PHONE_PATTERN.test(phone),

  /** Validate currency code */
  isValidCurrencyCode: (code: string): boolean => CURRENCY_CODE_PATTERN.test(code),

  /** Validate country code */
  isValidCountryCode: (code: string): boolean => COUNTRY_CODE_PATTERN.test(code),

  /** Validate pagination parameters */
  isValidPagination: (params: PaginationParams): boolean => {
    const { first, last, after, before } = params;

    // Can't specify both first and last
    if (first !== undefined && last !== undefined) {
      return false;
    }

    // Can't specify both after and before
    if (after !== undefined && before !== undefined) {
      return false;
    }

    // First/last must be between 1 and MAX_PAGE_SIZE
    if (first !== undefined && (first < 1 || first > MAX_PAGE_SIZE)) {
      return false;
    }
    if (last !== undefined && (last < 1 || last > MAX_PAGE_SIZE)) {
      return false;
    }

    return true;
  },
} as const;
