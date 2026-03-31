import type { PluginLogger } from "openclaw/plugin-sdk/core";
import type { ResolvedDatabricksRuntimeConfig } from "./config.js";
import { DatabricksHttpError, normalizeDatabricksError, isRetryableStatus } from "./errors.js";
import { logDatabricks } from "./logger.js";

type DatabricksFetch = typeof fetch;

type DatabricksSqlRequest = {
  statement: string;
  warehouseId: string;
  catalog?: string;
  schema?: string;
};

type RetryOptions = {
  maxAttempts: number;
  minDelayMs: number;
};

type DatabricksClientDeps = {
  fetchImpl?: DatabricksFetch;
  sleep?: (ms: number) => Promise<void>;
};

function toErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const asRecord = payload as Record<string, unknown>;
    const message = asRecord.message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
    const errorMessage = asRecord.error_message;
    if (typeof errorMessage === "string" && errorMessage.trim()) {
      return errorMessage.trim();
    }
  }
  return fallback;
}

async function parseResponsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("application/json")) {
    return response.json();
  }
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function buildRetryOptions(retryCount: number): RetryOptions {
  return {
    maxAttempts: Math.max(1, retryCount + 1),
    minDelayMs: 250,
  };
}

function shouldRetry(params: {
  statusCode?: number;
  attempt: number;
  retry: RetryOptions;
}): boolean {
  if (params.attempt >= params.retry.maxAttempts) {
    return false;
  }
  if (params.statusCode === undefined) {
    return true;
  }
  return isRetryableStatus(params.statusCode);
}

function buildBackoffMs(attempt: number, retry: RetryOptions): number {
  const exponential = retry.minDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, 2_000);
}

export class DatabricksSqlClient {
  private readonly fetchImpl: DatabricksFetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly config: ResolvedDatabricksRuntimeConfig;
  private readonly logger: PluginLogger;

  constructor(params: {
    config: ResolvedDatabricksRuntimeConfig;
    logger: PluginLogger;
    deps?: DatabricksClientDeps;
  }) {
    this.config = params.config;
    this.logger = params.logger;
    this.fetchImpl = params.deps?.fetchImpl ?? fetch;
    this.sleep =
      params.deps?.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))));
  }

  async executeStatement(request: DatabricksSqlRequest): Promise<unknown> {
    const retry = buildRetryOptions(this.config.retryCount);
    const endpoint = `${this.config.host}/api/2.0/sql/statements`;
    const body = {
      statement: request.statement,
      warehouse_id: request.warehouseId,
      disposition: "INLINE",
      ...(request.catalog ? { catalog: request.catalog } : {}),
      ...(request.schema ? { schema: request.schema } : {}),
    };

    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const response = await this.fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const payload = await parseResponsePayload(response);
        if (!response.ok) {
          const message = toErrorMessage(
            payload,
            `Databricks SQL API request failed with status ${response.status}.`,
          );
          const error = new DatabricksHttpError({
            statusCode: response.status,
            message,
          });
          if (shouldRetry({ statusCode: response.status, attempt, retry })) {
            const delayMs = buildBackoffMs(attempt, retry);
            logDatabricks(this.logger, "warn", "Retrying SQL API request after HTTP error.", {
              statusCode: response.status,
              attempt,
              delayMs,
            });
            await this.sleep(delayMs);
            continue;
          }
          throw error;
        }
        return payload;
      } catch (error) {
        const normalized = normalizeDatabricksError(
          error,
          `Databricks SQL request timed out after ${this.config.timeoutMs}ms.`,
        );
        if (shouldRetry({ attempt, retry }) && normalized.retryable) {
          const delayMs = buildBackoffMs(attempt, retry);
          logDatabricks(this.logger, "warn", "Retrying SQL API request after transient error.", {
            code: normalized.code,
            attempt,
            delayMs,
          });
          await this.sleep(delayMs);
          continue;
        }
        throw normalized;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new DatabricksHttpError({
      statusCode: 500,
      message: "Databricks SQL request exhausted retry attempts.",
      retryable: false,
    });
  }
}

export function createDatabricksSqlClient(params: {
  config: ResolvedDatabricksRuntimeConfig;
  logger: PluginLogger;
  deps?: DatabricksClientDeps;
}): DatabricksSqlClient {
  return new DatabricksSqlClient(params);
}
