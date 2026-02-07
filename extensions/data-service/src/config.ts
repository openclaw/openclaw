/**
 * Data-Service configuration types and resolution.
 *
 * For Wexa Coworker Web integration:
 * - orgId/userId MUST be set via data-service.setContext gateway method
 * - No fallback to environment variables for user context
 * - Server-level config (url, serverKey) still comes from env vars
 */

import { getRequestContext } from "./request-context.js";

/** S3 configuration for project virtual disks */
export type S3Config = {
  /** Enable/disable S3-backed filesystem tools */
  enabled?: boolean;
  /** S3 bucket name */
  bucket?: string;
  /** AWS region (default: us-east-1) */
  region?: string;
  /** AWS access key ID (optional, uses default credential chain if not provided) */
  accessKeyId?: string;
  /** AWS secret access key (optional, uses default credential chain if not provided) */
  secretAccessKey?: string;
  /** Maximum file size in bytes (default: 10MB) */
  maxFileSizeBytes?: number;
};

/** Configuration for the Data-Service connector tools */
export type DataServiceConfig = {
  /** Enable/disable the Data-Service connector tools */
  enabled?: boolean;
  /** Base URL for the Data-Service API */
  url?: string;
  /** Server key for system calls (required) */
  serverKey?: string;
  /** Pre-configured connector IDs by connector type (optional overrides) */
  connectorIds?: Record<string, string>;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
  /** S3 configuration for project virtual disks */
  s3?: S3Config;
};

const DEFAULT_DATA_SERVICE_URL = "https://dev.api.wexa.ai";

/**
 * Resolve Data-Service configuration from plugin config and env vars.
 *
 * Note: orgId/userId are NOT resolved here — they MUST come from
 * the request context set via data-service.setContext.
 */
export function resolveDataServiceConfig(
  pluginConfig?: Record<string, unknown>,
): DataServiceConfig {
  const pc = pluginConfig as DataServiceConfig | undefined;

  // Resolve S3 config from plugin config and env vars
  const s3Bucket = pc?.s3?.bucket ?? process.env.S3_BUCKET;
  const s3Config: S3Config | undefined = s3Bucket
    ? {
        enabled: pc?.s3?.enabled ?? !!s3Bucket,
        bucket: s3Bucket,
        region: pc?.s3?.region ?? process.env.S3_REGION ?? "us-east-1",
        accessKeyId: pc?.s3?.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: pc?.s3?.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY,
        maxFileSizeBytes: pc?.s3?.maxFileSizeBytes ?? 10 * 1024 * 1024, // 10MB default
      }
    : undefined;

  return {
    enabled: pc?.enabled ?? !!process.env.DATA_SERVICE_URL,
    url: pc?.url ?? process.env.DATA_SERVICE_URL ?? DEFAULT_DATA_SERVICE_URL,
    serverKey: pc?.serverKey ?? process.env.DATA_SERVICE_SERVER_KEY,
    connectorIds: pc?.connectorIds,
    timeoutMs: pc?.timeoutMs ?? 30000,
    s3: s3Config,
  };
}

/**
 * Get user context for the current request.
 *
 * orgId/userId MUST be set via data-service.setContext before calling agent.
 * Returns undefined values if context is not set — tools should return an error.
 */
export function getEffectiveUserContext(): {
  orgId?: string;
  userId?: string;
  projectId?: string;
  apiKey?: string;
} {
  const reqCtx = getRequestContext();

  if (!reqCtx) {
    return {
      orgId: undefined,
      userId: undefined,
      projectId: undefined,
      apiKey: undefined,
    };
  }

  return {
    orgId: reqCtx.orgId,
    userId: reqCtx.userId,
    projectId: reqCtx.projectId,
    apiKey: reqCtx.apiKey,
  };
}

/**
 * Check if user context is set for the current request.
 */
export function hasUserContext(): boolean {
  const ctx = getRequestContext();
  return !!(ctx?.orgId && ctx?.userId);
}

/**
 * Check if filesystem context is set (requires projectId in addition to user context).
 */
export function hasFilesystemContext(): boolean {
  const ctx = getRequestContext();
  return !!(ctx?.orgId && ctx?.userId && ctx?.projectId);
}

/**
 * Error message when user context is not set.
 */
export const MISSING_CONTEXT_ERROR =
  "User context not set. Call data-service.setContext with orgId and userId before calling the agent.";

/**
 * Error message when filesystem context (projectId) is not set.
 */
export const MISSING_PROJECT_ERROR =
  "Project context not set. Call data-service.setContext with orgId, userId, and projectId to use filesystem tools.";
