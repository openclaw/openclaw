import type { PluginLogger } from "openclaw/plugin-sdk/core";
import type { ResolvedDatabricksRuntimeConfig } from "./config.js";
import {
  DatabricksError,
  DatabricksHttpError,
  isRetryableStatus,
  normalizeDatabricksError,
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
    error_code?: string;
    error_message?: string;
  };
  [key: string]: unknown;
};

type DatabricksClientDeps = {
  fetchImpl?: DatabricksFetch;
  sleep?: (ms: number) => Promise<void>;
};

type RetryOptions = {
  maxAttempts: number;
  minDelayMs: number;
};

function toErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const asRecord = payload as Record<string, unknown>;
    const status = asRecord.status;
    if (status && typeof status === "object") {
      const statusMessage = (status as Record<string, unknown>).error_message;
      if (typeof statusMessage === "string" && statusMessage.trim()) {
        return statusMessage.trim();
      }
    }
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

function isSuccessfulTerminalStatus(status: DatabricksSqlStatus | null): boolean {
  return status === "SUCCEEDED";
}

function isFailedTerminalStatus(status: DatabricksSqlStatus | null): boolean {
  return status === "FAILED" || status === "CANCELED";
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
    const endpoint = `${this.config.host}/api/2.0/sql/statements`;
    const payload = await this.requestWithRetry({
      method: "POST",
      endpoint,
      timeoutMs: this.config.timeoutMs,
      stage: "submit",
      body: {
        statement: request.statement,
        warehouse_id: request.warehouseId,
        disposition: "INLINE",
        ...(request.catalog ? { catalog: request.catalog } : {}),
        ...(request.schema ? { schema: request.schema } : {}),
      },
    });

    const status = getStatementStatus(payload);
    if (isPendingStatus(status)) {
      const statementId =
        payload && typeof payload === "object"
          ? (payload as DatabricksStatementPayload).statement_id
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

    return this.assertTerminalPayload(payload, "submit");
  }

  private assertTerminalPayload(payload: unknown, stage: "submit" | "poll"): unknown {
    const status = getStatementStatus(payload);
    if (status === null) {
      return payload;
    }
    if (isSuccessfulTerminalStatus(status)) {
      return payload;
    }
    if (isFailedTerminalStatus(status)) {
      const message = toErrorMessage(
        payload,
        `Databricks statement ended with terminal status ${status}.`,
      );
      throw new DatabricksError({
        code: "STATEMENT_FAILED",
        message,
        retryable: false,
        details: {
          stage,
          status,
          errorCode:
            payload && typeof payload === "object"
              ? (payload as DatabricksStatementPayload).status?.error_code
              : undefined,
        },
      });
    }
    throw new DatabricksError({
      code: "REQUEST_ERROR",
      message: `Databricks statement returned unsupported status: ${status}.`,
      retryable: false,
      details: { stage, status },
    });
  }

  private async pollStatement(statementId: string): Promise<unknown> {
    const startedAt = Date.now();
    const endpoint = `${this.config.host}/api/2.0/sql/statements/${encodeURIComponent(statementId)}`;

    while (Date.now() - startedAt <= this.config.maxPollingWaitMs) {
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = this.config.maxPollingWaitMs - elapsedMs;
      if (remainingMs <= 0) {
        break;
      }
      const requestTimeoutMs = Math.max(1_000, Math.min(this.config.timeoutMs, remainingMs));

      const payload = await this.requestWithRetry({
        method: "GET",
        endpoint,
        timeoutMs: requestTimeoutMs,
        stage: "poll",
        remainingMs,
        statementId,
      });

      const status = getStatementStatus(payload);
      if (!isPendingStatus(status)) {
        return this.assertTerminalPayload(payload, "poll");
      }

      const delayMs = Math.min(this.config.pollingIntervalMs, Math.max(0, remainingMs));
      logDatabricks(this.logger, "debug", "Polling Databricks statement status.", {
        statementId,
        status,
        delayMs,
        elapsedMs,
      });
      await this.sleep(delayMs);
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

  private async requestWithRetry(params: {
    method: "GET" | "POST";
    endpoint: string;
    timeoutMs: number;
    stage: "submit" | "poll";
    remainingMs?: number;
    statementId?: string;
    body?: Record<string, unknown>;
  }): Promise<unknown> {
    const retry = buildRetryOptions(this.config.retryCount);
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
      try {
        const response = await this.fetchImpl(params.endpoint, {
          method: params.method,
          headers: {
            Authorization: `Bearer ${this.config.token}`,
            ...(params.body ? { "Content-Type": "application/json" } : {}),
          },
          ...(params.body ? { body: JSON.stringify(params.body) } : {}),
          signal: controller.signal,
        });
        const payload = await parseResponsePayload(response);
        if (!response.ok) {
          const message = toErrorMessage(
            payload,
            `Databricks ${params.stage} request failed with status ${response.status}.`,
          );
          const error = new DatabricksHttpError({
            statusCode: response.status,
            message,
          });
          if (shouldRetry({ statusCode: response.status, attempt, retry })) {
            const delayMs = buildBackoffMs(attempt, retry);
            if (
              params.stage === "poll" &&
              params.remainingMs !== undefined &&
              delayMs > params.remainingMs
            ) {
              throw new DatabricksError({
                code: "POLLING_RETRY_EXHAUSTED",
                message: "Databricks polling transient retries exhausted remaining wait budget.",
                retryable: false,
              });
            }
            logDatabricks(this.logger, "warn", "Retrying Databricks request after HTTP error.", {
              stage: params.stage,
              statementId: params.statementId,
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
          `Databricks ${params.stage} request timed out after ${params.timeoutMs}ms.`,
        );
        if (normalized.code === "TIMEOUT" && params.stage === "submit") {
          throw new DatabricksError({
            code: "STATEMENT_TIMEOUT",
            message: normalized.message,
            retryable: normalized.retryable,
          });
        }
        if (shouldRetry({ attempt, retry }) && normalized.retryable) {
          const delayMs = buildBackoffMs(attempt, retry);
          if (
            params.stage === "poll" &&
            params.remainingMs !== undefined &&
            delayMs > params.remainingMs
          ) {
            throw new DatabricksError({
              code: "POLLING_RETRY_EXHAUSTED",
              message: "Databricks polling transient retries exhausted remaining wait budget.",
              retryable: false,
            });
          }
          logDatabricks(this.logger, "warn", "Retrying Databricks request after transient error.", {
            stage: params.stage,
            statementId: params.statementId,
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
    throw new DatabricksError({
      code: params.stage === "poll" ? "POLLING_RETRY_EXHAUSTED" : "REQUEST_ERROR",
      message:
        params.stage === "poll"
          ? "Databricks polling exhausted retry attempts."
          : "Databricks submit request exhausted retry attempts.",
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
