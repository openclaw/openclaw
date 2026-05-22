export type RequestPriority = "critical" | "standard" | "background";
export type RequestQuery = Record<string, string | number | boolean>;
type ScheduledRequest<TData> = {
    method: string;
    path: string;
    data?: TData;
    enqueuedAt: number;
    generation: number;
    priority: RequestPriority;
    query?: RequestQuery;
    routeKey: string;
    retryCount: number;
    resolve: (value?: unknown) => void;
    reject: (reason?: unknown) => void;
};
export type RestSchedulerLaneOptions = {
    maxQueueSize: number;
    staleAfterMs?: number;
    weight: number;
};
export type RestSchedulerOptions = {
    lanes: Record<RequestPriority, RestSchedulerLaneOptions>;
    maxConcurrency: number;
    maxQueueSize: number;
    maxRateLimitRetries: number;
};
export declare class RestScheduler<TData> {
    private readonly options;
    private readonly executor;
    private activeWorkers;
    private buckets;
    private drainTimer;
    private globalRateLimitUntil;
    private invalidRequestTimestamps;
    private laneCursor;
    private laneDropped;
    private laneSchedule;
    private queuedByLane;
    private queueGeneration;
    private queuedRequests;
    private routeBuckets;
    constructor(options: RestSchedulerOptions, executor: (request: ScheduledRequest<TData>) => Promise<unknown>);
    enqueue(params: {
        method: string;
        path: string;
        data?: TData;
        priority: RequestPriority;
        query?: RequestQuery;
    }): Promise<unknown>;
    recordResponse(routeKey: string, path: string, response: Response, parsed: unknown): void;
    clearQueue(): void;
    abortPending(): void;
    get queueSize(): number;
    getMetrics(): {
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
            background: number;
            critical: number;
            standard: number;
        };
        droppedByLane: {
            background: number;
            critical: number;
            standard: number;
        };
        oldestQueuedByLane: {
            [k: string]: number;
        };
        activeWorkers: number;
        maxConcurrentWorkers: number;
    };
    private get maxConcurrentWorkers();
    private get maxRateLimitRetries();
    private getBucket;
    private hasBucketReference;
    private isBucketRateLimited;
    private pruneRouteMapping;
    private pruneIdleRouteMappings;
    private shouldPruneIdleBucket;
    private bindRouteToBucket;
    private updateRateLimitState;
    private recordInvalidRequest;
    private pruneInvalidRequests;
    private getBucketWaitMs;
    private scheduleDrain;
    private drainQueues;
    private takeNextQueuedRequest;
    private dropStaleHeadRequests;
    private pruneIdleBuckets;
    private runQueuedRequest;
    private requeueRateLimitedRequest;
    private rejectPending;
    private buildLaneSchedule;
    private getOldestQueuedAge;
}
export {};
