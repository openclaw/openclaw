import type { PluginLogger } from "openclaw/plugin-sdk/core";
import type { ResolvedDatabricksRuntimeConfig } from "./config.js";
import {
  DatabricksError,
  DatabricksHttpError,
  normalizeDatabricksError,
  isRetryableStatus,
} from "./errors.js";
import { logDatabricks } from "./logger.js";

type DatabricksFetch = typeof fetch;

type DatabricksSqlRequest = {
  statement: string;
  warehouseId: string;
  catalog?: string;
  schema?: string;
};

type DatabricksSqlStatus = "PENDING" | "RUNNING" | "QUEUED" | "SUCCEEDED" | "FAILED" | "CANCELED";

type DatabricksStatementPayload = {
  statement_id?: string;
  status?: {
    state?: string;
  };
  [key: string]: unknown;
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

function getStatementStatus(payload: unknown): DatabricksSqlStatus | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const statusValue = (payload as DatabricksStatementPayload).status?.state;
  if (typeof statusValue !== "string") {
    return null;
  }
  const normalized = statusValue.toUpperCase();
  if (
    normalized === "PENDING" ||
    normalized === "RUNNING" ||
    normalized === "QUEUED" ||
    normalized === "SUCCEEDED" ||
    normalized === "FAILED" ||
    normalized === "CANCELED"
  ) {
    return normalized;
  }
  return null;
}

function isPendingStatus(status: DatabricksSqlStatus | null): boolean {
  return status === "PENDING" || status === "RUNNING" || status === "QUEUED";
}

function buildTransientPollingDelayMs(params: {
  attempt: number;
  pollingIntervalMs: number;
  remainingMs: number;
}): number {
  const base = Math.max(200, params.pollingIntervalMs);
  const delayMs = Math.min(base * 2 ** Math.max(0, params.attempt - 1), 2_000);
  return Math.max(0, Math.min(delayMs, params.remainingMs));
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
        return this.resolveFinalStatementPayload(payload);
      } catch (error) {
        const normalized = normalizeDatabricksError(
          error,
          `Databricks SQL request timed out after ${this.config.timeoutMs}ms.`,
        );
        if (normalized.code === "TIMEOUT") {
          throw new DatabricksError({
            code: "STATEMENT_TIMEOUT",
            message: normalized.message,
            retryable: normalized.retryable,
          });
        }
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

  private async pollStatement(statementId: string): Promise<unknown> {
    const startedAt = Date.now();
    let transientAttempt = 0;
    let exhaustedByTransientErrors = false;
    const endpoint = `${this.config.host}/api/2.0/sql/statements/${encodeURIComponent(statementId)}`;

    while (Date.now() - startedAt <= this.config.maxPollingWaitMs) {
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = this.config.maxPollingWaitMs - elapsedMs;
      if (remainingMs <= 0) {
        break;
      }
      const requestTimeoutMs = Math.max(1_000, Math.min(this.config.timeoutMs, remainingMs));

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await this.fetchImpl(endpoint, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.config.token}`,
          },
          signal: controller.signal,
        });
        const payload = await parseResponsePayload(response);
        if (!response.ok) {
          const message = toErrorMessage(
            payload,
            `Databricks statement polling failed with status ${response.status}.`,
          );
          const error = new DatabricksHttpError({
            statusCode: response.status,
            message,
          });
          if (error.retryable) {
            transientAttempt += 1;
            exhaustedByTransientErrors = true;
            const delayMs = buildTransientPollingDelayMs({
              attempt: transientAttempt,
              pollingIntervalMs: this.config.pollingIntervalMs,
              remainingMs,
            });
            if (delayMs <= 0) {
              throw new DatabricksError({
                code: "POLLING_TIMEOUT",
                message:
                  "Databricks statement polling exceeded time budget while handling transient errors.",
                retryable: false,
              });
            }
            logDatabricks(this.logger, "warn", "Transient polling HTTP error; retrying.", {
              statementId,
              statusCode: response.status,
              transientAttempt,
              delayMs,
            });
            await this.sleep(delayMs);
            continue;
          }
          throw error;
        }

        const status = getStatementStatus(payload);
        transientAttempt = 0;
        exhaustedByTransientErrors = false;
        if (!isPendingStatus(status)) {
          return payload;
        }

        const delayMs = Math.min(this.config.pollingIntervalMs, Math.max(0, remainingMs));
        logDatabricks(this.logger, "debug", "Polling Databricks statement status.", {
          statementId,
          status,
          delayMs,
          elapsedMs,
        });
        await this.sleep(delayMs);
      } catch (error) {
        const normalized = normalizeDatabricksError(
          error,
          `Databricks statement polling timed out after ${requestTimeoutMs}ms.`,
        );
        if (normalized.retryable) {
          transientAttempt += 1;
          exhaustedByTransientErrors = true;
          const delayMs = buildTransientPollingDelayMs({
            attempt: transientAttempt,
            pollingIntervalMs: this.config.pollingIntervalMs,
            remainingMs,
          });
          if (delayMs <= 0) {
            throw new DatabricksError({
              code: "POLLING_TIMEOUT",
              message:
                "Databricks statement polling exceeded time budget while handling transient errors.",
              retryable: false,
            });
          }
          logDatabricks(this.logger, "warn", "Transient polling error; retrying.", {
            statementId,
            code: normalized.code,
            transientAttempt,
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

    if (exhaustedByTransientErrors) {
      throw new DatabricksError({
        code: "POLLING_TIMEOUT",
        message:
          "Databricks statement polling exceeded time budget while handling transient errors.",
        retryable: false,
      });
    }

    throw new DatabricksError({
      code: "STATEMENT_PENDING_MAX_WAIT",
      message: `Databricks statement is still pending after ${this.config.maxPollingWaitMs}ms.`,
      retryable: false,
      details: {
        maxPollingWaitMs: this.config.maxPollingWaitMs,
        pollingIntervalMs: this.config.pollingIntervalMs,
      },
    });
  }

  private async resolveFinalStatementPayload(initialPayload: unknown): Promise<unknown> {
    const status = getStatementStatus(initialPayload);
    if (!isPendingStatus(status)) {
      return initialPayload;
    }

    const statementId =
      initialPayload && typeof initialPayload === "object"
        ? (initialPayload as DatabricksStatementPayload).statement_id
        : undefined;
    if (!statementId || typeof statementId !== "string") {
      throw new DatabricksError({
        code: "POLLING_TIMEOUT",
        message: "Databricks statement is pending, but statement_id is missing for polling.",
        retryable: false,
      });
    }

    return this.pollStatement(statementId);
  }
}

export function createDatabricksSqlClient(params: {
  config: ResolvedDatabricksRuntimeConfig;
  logger: PluginLogger;
  deps?: DatabricksClientDeps;
}): DatabricksSqlClient {
  return new DatabricksSqlClient(params);
}
