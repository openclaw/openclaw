/**
 * DingTalk Document Management API
 *
 * Provides DingTalk knowledge base document management capabilities:
 * - listDocSpaces: Query knowledge base list
 * - createDocSpace: Create knowledge base
 * - createDocument: Create document in knowledge base
 * - getDocumentInfo: Get document/node info
 * - listDocNodes: Query knowledge base node list
 * - deleteDocNode: Delete knowledge base node
 *
 * API Docs:
 * - Knowledge base list: https://open.dingtalk.com/document/development/queries-team-space-list
 * - Create knowledge base: https://open.dingtalk.com/document/development/create-a-team-space
 * - Create document: https://open.dingtalk.com/document/development/create-team-space-document
 * - Get node: https://open.dingtalk.com/document/development/obtain-node-information
 * - Node list: https://open.dingtalk.com/document/development/queries-team-space-node-list
 */

import { getAccessToken } from "./client.js";
import { dingtalkLogger } from "./logger.js";
import type {
  DingtalkConfig,
  DocSpace,
  ListDocSpacesResult,
  CreateDocumentParams,
  DocNode,
  ListDocNodesParams,
  ListDocNodesResult,
} from "./types.js";

/** DingTalk API base URL */
const DINGTALK_API_BASE = "https://api.dingtalk.com";

/** HTTP request timeout (milliseconds) */
const REQUEST_TIMEOUT = 30_000;

// ============================================================================
// Internal Utility Functions
// ============================================================================

interface DingtalkApiErrorResponse {
  code?: string;
  message?: string;
  requestid?: string;
}

async function dingtalkApiRequest<ResponseType>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  accessToken: string,
  options?: {
    body?: Record<string, unknown>;
    query?: Record<string, string>;
    operationLabel?: string;
  },
): Promise<ResponseType> {
  const operationLabel = options?.operationLabel ?? `${method} ${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    let url = `${DINGTALK_API_BASE}${path}`;

    if (options?.query) {
      const searchParams = new URLSearchParams(options.query);
      url = `${url}?${searchParams.toString()}`;
    }

    const fetchOptions: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      signal: controller.signal,
    };

    if (options?.body && method !== "GET") {
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `DingTalk ${operationLabel} failed: HTTP ${response.status}`;

      try {
        const errorData = JSON.parse(errorText) as DingtalkApiErrorResponse;
        if (errorData.message) {
          errorMessage = `DingTalk ${operationLabel} failed: ${errorData.message} (code: ${errorData.code ?? "unknown"}, requestId: ${errorData.requestid ?? "unknown"})`;
        }
      } catch {
        errorMessage = `${errorMessage} - ${errorText}`;
      }

      throw new Error(errorMessage);
    }

    const responseText = await response.text();
    if (!responseText) {
      return {} as ResponseType;
    }

    return JSON.parse(responseText) as ResponseType;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`DingTalk ${operationLabel} timed out after ${REQUEST_TIMEOUT}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function resolveAccessToken(cfg: DingtalkConfig): Promise<string> {
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error("DingTalk credentials not configured (clientId, clientSecret required)");
  }
  return getAccessToken(cfg.clientId, cfg.clientSecret);
}

// ============================================================================
// Knowledge Base/Document Management API
// ============================================================================

/**
 * Query knowledge base list
 *
 * Get list of knowledge bases under current enterprise.
 *
 * @param cfg DingTalk config
 * @param operatorUserId Operator's unionId
 * @param nextToken Pagination token
 * @param maxResults Page size, default 20
 * @returns Knowledge base list
 */
export async function listDocSpaces(
  cfg: DingtalkConfig,
  operatorUserId: string,
  nextToken?: string,
  maxResults?: number,
): Promise<ListDocSpacesResult> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Listing doc spaces for user ${operatorUserId}`);

  const query: Record<string, string> = {
    operatorId: operatorUserId,
  };
  if (nextToken) query.nextToken = nextToken;
  if (maxResults) query.maxResults = String(maxResults);

  return dingtalkApiRequest<ListDocSpacesResult>("GET", "/v1.0/doc/teams", accessToken, {
    query,
    operationLabel: "list doc spaces",
  });
}

/**
 * Create knowledge base
 *
 * @param cfg DingTalk config
 * @param operatorUserId Operator's unionId
 * @param name Knowledge base name
 * @param description Knowledge base description
 * @returns Created knowledge base info
 */
export async function createDocSpace(
  cfg: DingtalkConfig,
  operatorUserId: string,
  name: string,
  description?: string,
): Promise<DocSpace> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Creating doc space "${name}" for user ${operatorUserId}`);

  const body: Record<string, unknown> = {
    name,
    operatorId: operatorUserId,
  };
  if (description) body.description = description;

  const result = await dingtalkApiRequest<DocSpace>("POST", "/v1.0/doc/teams", accessToken, {
    body,
    operationLabel: "create doc space",
  });

  dingtalkLogger.info(`Doc space created: id=${result.id}, name="${name}"`);
  return result;
}

/**
 * Create document in knowledge base
 *
 * Supports creating documents (alidoc) or folders (folder).
 *
 * @param cfg DingTalk config
 * @param operatorUserId Operator's unionId
 * @param spaceId Knowledge base ID
 * @param params Create document parameters
 * @returns Created document node info
 *
 * @example
 * ```ts
 * const doc = await createDocument(cfg, "user123", "spaceXxx", {
 *   name: "Weekly Project Report",
 *   docType: "alidoc",
 *   content: "# This Week's Summary\n\n## Completed Items\n- ...",
 * });
 * ```
 */
export async function createDocument(
  cfg: DingtalkConfig,
  operatorUserId: string,
  spaceId: string,
  params: CreateDocumentParams,
): Promise<DocNode> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(
    `Creating document "${params.name}" in space ${spaceId} for user ${operatorUserId}`,
  );

  const body: Record<string, unknown> = {
    name: params.name,
    docType: params.docType ?? "alidoc",
    operatorId: operatorUserId,
  };

  if (params.parentNodeId) body.parentNodeId = params.parentNodeId;

  const result = await dingtalkApiRequest<DocNode>(
    "POST",
    `/v1.0/doc/teams/${spaceId}/nodes`,
    accessToken,
    { body, operationLabel: "create document" },
  );

  dingtalkLogger.info(`Document created: nodeId=${result.nodeId}, name="${params.name}"`);
  return result;
}

/**
 * Get document/node info
 *
 * @param cfg DingTalk config
 * @param operatorUserId Operator's unionId
 * @param spaceId Knowledge base ID
 * @param nodeId Node ID
 * @returns Node info
 */
export async function getDocumentInfo(
  cfg: DingtalkConfig,
  operatorUserId: string,
  spaceId: string,
  nodeId: string,
): Promise<DocNode> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Getting document info: space=${spaceId}, node=${nodeId}`);

  const query: Record<string, string> = {
    operatorId: operatorUserId,
  };

  return dingtalkApiRequest<DocNode>(
    "GET",
    `/v1.0/doc/teams/${spaceId}/nodes/${nodeId}`,
    accessToken,
    { query, operationLabel: "get document info" },
  );
}

/**
 * Query knowledge base node list
 *
 * @param cfg DingTalk config
 * @param operatorUserId Operator's unionId
 * @param spaceId Knowledge base ID
 * @param params Query parameters
 * @returns Node list
 */
export async function listDocNodes(
  cfg: DingtalkConfig,
  operatorUserId: string,
  spaceId: string,
  params?: ListDocNodesParams,
): Promise<ListDocNodesResult> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Listing doc nodes in space ${spaceId}`);

  const query: Record<string, string> = {
    operatorId: operatorUserId,
  };
  if (params?.parentNodeId) query.parentNodeId = params.parentNodeId;
  if (params?.nextToken) query.nextToken = params.nextToken;
  if (params?.maxResults) query.maxResults = String(params.maxResults);

  return dingtalkApiRequest<ListDocNodesResult>(
    "GET",
    `/v1.0/doc/teams/${spaceId}/nodes`,
    accessToken,
    { query, operationLabel: "list doc nodes" },
  );
}

/**
 * Delete knowledge base node
 *
 * @param cfg DingTalk config
 * @param operatorUserId Operator's unionId
 * @param spaceId Knowledge base ID
 * @param nodeId Node ID
 */
export async function deleteDocNode(
  cfg: DingtalkConfig,
  operatorUserId: string,
  spaceId: string,
  nodeId: string,
): Promise<void> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Deleting doc node: space=${spaceId}, node=${nodeId}`);

  const query: Record<string, string> = {
    operatorId: operatorUserId,
  };

  await dingtalkApiRequest<Record<string, unknown>>(
    "DELETE",
    `/v1.0/doc/teams/${spaceId}/nodes/${nodeId}`,
    accessToken,
    { query, operationLabel: "delete doc node" },
  );

  dingtalkLogger.info(`Doc node ${nodeId} deleted from space ${spaceId}`);
}
