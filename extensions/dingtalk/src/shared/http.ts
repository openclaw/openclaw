/**
 * 通用 HTTP 客户端封装
 *
 * 提供带超时和错误处理的 HTTP 请求功能
 */

/**
 * HTTP 请求选项
 */
export interface HttpRequestOptions {
  /** 请求超时时间（毫秒），默认 30000 */
  timeout?: number;
  /** 请求头 */
  headers?: Record<string, string>;
}

/**
 * HTTP 错误
 */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * 超时错误
 */
export class TimeoutError extends Error {
  constructor(
    message: string,
    public readonly timeoutMs: number,
  ) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * 发送 HTTP POST 请求
 *
 * @param url 请求 URL
 * @param body 请求体
 * @param options 请求选项
 * @returns 响应数据
 *
 * @example
 * ```ts
 * const data = await httpPost("https://api.example.com/token", { key: "value" }, { timeout: 10000 });
 * ```
 */
export async function httpPost<T = unknown>(
  url: string,
  body: unknown,
  options?: HttpRequestOptions,
): Promise<T> {
  const { timeout = 30000, headers = {} } = options ?? {};

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      throw new HttpError(
        `HTTP ${response.status}: ${response.statusText}`,
        response.status,
        responseBody,
      );
    }

    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(`Request timeout after ${timeout}ms`, timeout);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 发送 HTTP GET 请求
 *
 * @param url 请求 URL
 * @param options 请求选项
 * @returns 响应数据
 *
 * @example
 * ```ts
 * const data = await httpGet("https://api.example.com/data", { timeout: 10000 });
 * ```
 */
export async function httpGet<T = unknown>(url: string, options?: HttpRequestOptions): Promise<T> {
  const { timeout = 30000, headers = {} } = options ?? {};

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      throw new HttpError(
        `HTTP ${response.status}: ${response.statusText}`,
        response.status,
        responseBody,
      );
    }

    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(`Request timeout after ${timeout}ms`, timeout);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * HTTP 重试策略
 *
 * 提供可配置的重试逻辑
 */

/**
 * 重试选项
 */
export interface RetryOptions {
  /** 最大重试次数，默认 3 */
  maxRetries?: number;
  /** 初始延迟时间（毫秒），默认 1000 */
  initialDelay?: number;
  /** 最大延迟时间（毫秒），默认 10000 */
  maxDelay?: number;
  /** 延迟倍数（指数退避），默认 2 */
  backoffMultiplier?: number;
  /** 判断是否应该重试的函数 */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

/**
 * 默认的重试判断函数
 * 对于网络错误和 5xx 错误进行重试
 */
export function defaultShouldRetry(error: unknown): boolean {
  if (error instanceof Error) {
    // 网络错误
    if (error.name === "TypeError" || error.name === "TimeoutError") {
      return true;
    }
    // HTTP 5xx 错误
    if ("status" in error && typeof (error as { status: number }).status === "number") {
      const status = (error as { status: number }).status;
      return status >= 500 && status < 600;
    }
  }
  return false;
}

/**
 * 计算延迟时间（指数退避）
 */
function calculateDelay(
  attempt: number,
  initialDelay: number,
  maxDelay: number,
  backoffMultiplier: number,
): number {
  const delay = initialDelay * Math.pow(backoffMultiplier, attempt - 1);
  return Math.min(delay, maxDelay);
}

/**
 * 延迟执行
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带重试的异步函数执行器
 *
 * @param fn 要执行的异步函数
 * @param options 重试选项
 * @returns 函数执行结果
 *
 * @example
 * ```ts
 * const result = await withRetry(
 *   () => httpPost(url, body),
 *   { maxRetries: 3, initialDelay: 1000 }
 * );
 * ```
 */
export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    backoffMultiplier = 2,
    shouldRetry = defaultShouldRetry,
  } = options ?? {};

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // 如果是最后一次尝试或不应该重试，直接抛出错误
      if (attempt > maxRetries || !shouldRetry(error, attempt)) {
        throw error;
      }

      // 计算延迟并等待
      const delay = calculateDelay(attempt, initialDelay, maxDelay, backoffMultiplier);
      await sleep(delay);
    }
  }

  // 理论上不会到达这里，但为了类型安全
  throw lastError;
}
