//#region extensions/discord/src/internal/rest-scheduler.d.ts
type RequestPriority$1 = "critical" | "standard" | "background";
type RequestQuery = Record<string, string | number | boolean>;
//#endregion
//#region extensions/discord/src/internal/rest.d.ts
type RuntimeProfile = "serverless" | "persistent";
type RequestPriority = RequestPriority$1;
type RequestSchedulerOptions = {
  lanes?: Partial<Record<RequestPriority, {
    maxQueueSize?: number;
    staleAfterMs?: number;
    weight?: number;
  }>>;
  maxConcurrency?: number;
  maxRateLimitRetries?: number;
};
type RequestClientOptions = {
  tokenHeader?: "Bot" | "Bearer";
  baseUrl?: string;
  apiVersion?: number;
  userAgent?: string;
  timeout?: number;
  queueRequests?: boolean;
  maxQueueSize?: number;
  runtimeProfile?: RuntimeProfile;
  scheduler?: RequestSchedulerOptions;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};
type RequestData = {
  body?: unknown;
  multipartStyle?: "message" | "form";
  rawBody?: boolean;
  headers?: Record<string, string>;
};
type QueuedRequest = {
  method: string;
  path: string;
  data?: RequestData;
  query?: RequestQuery;
  resolve: (value?: unknown) => void;
  reject: (reason?: unknown) => void;
  routeKey: string;
};
declare class RequestClient {
  readonly options: RequestClientOptions;
  protected token: string;
  protected customFetch: RequestClientOptions["fetch"];
  protected requestControllers: Set<AbortController>;
  private scheduler;
  constructor(token: string, options?: RequestClientOptions);
  get(path: string, query?: QueuedRequest["query"]): Promise<unknown>;
  post(path: string, data?: RequestData, query?: QueuedRequest["query"]): Promise<unknown>;
  patch(path: string, data?: RequestData, query?: QueuedRequest["query"]): Promise<unknown>;
  put(path: string, data?: RequestData, query?: QueuedRequest["query"]): Promise<unknown>;
  delete(path: string, data?: RequestData, query?: QueuedRequest["query"]): Promise<unknown>;
  protected request(method: string, path: string, params: {
    data?: RequestData;
    query?: QueuedRequest["query"];
  }): Promise<unknown>;
  protected executeRequest(method: string, path: string, params: {
    data?: RequestData;
    query?: QueuedRequest["query"];
  }, routeKey?: string): Promise<unknown>;
  clearQueue(): void;
  get queueSize(): number;
  getSchedulerMetrics(): {
    globalRateLimitUntil: number;
    activeBuckets: number;
    routeBucketMappings: number;
    buckets: {
      key: string;
      active: number;
      bucket: string | undefined;
      invalidRequests: number;
      pending: number;
      pendingByLane: {
        [k: string]: number;
      };
      rateLimitHits: number;
      remaining: number | undefined;
      resetAt: number;
      routeKeyCount: number;
    }[];
    invalidRequestCount: number;
    invalidRequestCountByStatus: Record<number, number>;
    queueSize: number;
    queueSizeByLane: {
      critical: number;
      background: number;
      standard: number;
    };
    droppedByLane: {
      critical: number;
      background: number;
      standard: number;
    };
    oldestQueuedByLane: {
      [k: string]: number;
    };
    activeWorkers: number;
    maxConcurrentWorkers: number;
  };
  abortAllRequests(): void;
}
//#endregion
export { RequestClientOptions as n, RequestClient as t };