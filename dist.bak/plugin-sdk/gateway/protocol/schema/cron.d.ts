import { type TSchema } from "@sinclair/typebox";
export declare const CronScheduleSchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
    kind: import("@sinclair/typebox").TLiteral<"at">;
    at: import("@sinclair/typebox").TString;
}>, import("@sinclair/typebox").TObject<{
    kind: import("@sinclair/typebox").TLiteral<"every">;
    everyMs: import("@sinclair/typebox").TInteger;
    anchorMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
}>, import("@sinclair/typebox").TObject<{
    kind: import("@sinclair/typebox").TLiteral<"cron">;
    expr: import("@sinclair/typebox").TString;
    tz: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    staggerMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
}>]>;
export declare const CronPayloadSchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
    kind: import("@sinclair/typebox").TLiteral<"systemEvent">;
    text: import("@sinclair/typebox").TString;
}>, import("@sinclair/typebox").TObject<{
    kind: import("@sinclair/typebox").TLiteral<"agentTurn">;
    message: TSchema;
    model: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    thinking: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    timeoutSeconds: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    allowUnsafeExternalContent: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    deliver: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    bestEffortDeliver: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
}>]>;
export declare const CronPayloadPatchSchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
    kind: import("@sinclair/typebox").TLiteral<"systemEvent">;
    text: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>, import("@sinclair/typebox").TObject<{
    kind: import("@sinclair/typebox").TLiteral<"agentTurn">;
    message: TSchema;
    model: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    thinking: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    timeoutSeconds: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    allowUnsafeExternalContent: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    deliver: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    bestEffortDeliver: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
}>]>;
export declare const CronDeliverySchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
    to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
    accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    bestEffort: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    mode: import("@sinclair/typebox").TLiteral<"none">;
}>, import("@sinclair/typebox").TObject<{
    to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
    accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    bestEffort: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    mode: import("@sinclair/typebox").TLiteral<"announce">;
}>, import("@sinclair/typebox").TObject<{
    to: import("@sinclair/typebox").TString;
    channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
    accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    bestEffort: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    mode: import("@sinclair/typebox").TLiteral<"webhook">;
}>]>;
export declare const CronDeliveryPatchSchema: import("@sinclair/typebox").TObject<{
    to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
    accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    bestEffort: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    mode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"none">, import("@sinclair/typebox").TLiteral<"announce">, import("@sinclair/typebox").TLiteral<"webhook">]>>;
}>;
export declare const CronJobStateSchema: import("@sinclair/typebox").TObject<{
    nextRunAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    runningAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    lastRunAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    lastRunStatus: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"ok">, import("@sinclair/typebox").TLiteral<"error">, import("@sinclair/typebox").TLiteral<"skipped">]>>;
    lastStatus: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"ok">, import("@sinclair/typebox").TLiteral<"error">, import("@sinclair/typebox").TLiteral<"skipped">]>>;
    lastError: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    lastDurationMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    consecutiveErrors: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    lastDelivered: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    lastDeliveryStatus: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"delivered">, import("@sinclair/typebox").TLiteral<"not-delivered">, import("@sinclair/typebox").TLiteral<"unknown">, import("@sinclair/typebox").TLiteral<"not-requested">]>>;
    lastDeliveryError: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const CronJobSchema: import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TString;
    agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    sessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    name: import("@sinclair/typebox").TString;
    description: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    enabled: import("@sinclair/typebox").TBoolean;
    deleteAfterRun: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    createdAtMs: import("@sinclair/typebox").TInteger;
    updatedAtMs: import("@sinclair/typebox").TInteger;
    schedule: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
        kind: import("@sinclair/typebox").TLiteral<"at">;
        at: import("@sinclair/typebox").TString;
    }>, import("@sinclair/typebox").TObject<{
        kind: import("@sinclair/typebox").TLiteral<"every">;
        everyMs: import("@sinclair/typebox").TInteger;
        anchorMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>, import("@sinclair/typebox").TObject<{
        kind: import("@sinclair/typebox").TLiteral<"cron">;
        expr: import("@sinclair/typebox").TString;
        tz: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        staggerMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>]>;
    sessionTarget: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"main">, import("@sinclair/typebox").TLiteral<"isolated">]>;
    wakeMode: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"next-heartbeat">, import("@sinclair/typebox").TLiteral<"now">]>;
    payload: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
        kind: import("@sinclair/typebox").TLiteral<"systemEvent">;
        text: import("@sinclair/typebox").TString;
    }>, import("@sinclair/typebox").TObject<{
        kind: import("@sinclair/typebox").TLiteral<"agentTurn">;
        message: TSchema;
        model: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        thinking: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        timeoutSeconds: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        allowUnsafeExternalContent: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        deliver: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        bestEffortDeliver: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    }>]>;
    delivery: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
        to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
        accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        bestEffort: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        mode: import("@sinclair/typebox").TLiteral<"none">;
    }>, import("@sinclair/typebox").TObject<{
        to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
        accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        bestEffort: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        mode: import("@sinclair/typebox").TLiteral<"announce">;
    }>, import("@sinclair/typebox").TObject<{
        to: import("@sinclair/typebox").TString;
        channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
        accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        bestEffort: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        mode: import("@sinclair/typebox").TLiteral<"webhook">;
    }>]>>;
    state: import("@sinclair/typebox").TObject<{
        nextRunAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        runningAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        lastRunAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        lastRunStatus: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"ok">, import("@sinclair/typebox").TLiteral<"error">, import("@sinclair/typebox").TLiteral<"skipped">]>>;
        lastStatus: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"ok">, import("@sinclair/typebox").TLiteral<"error">, import("@sinclair/typebox").TLiteral<"skipped">]>>;
        lastError: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        lastDurationMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        consecutiveErrors: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        lastDelivered: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        lastDeliveryStatus: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"delivered">, import("@sinclair/typebox").TLiteral<"not-delivered">, import("@sinclair/typebox").TLiteral<"unknown">, import("@sinclair/typebox").TLiteral<"not-requested">]>>;
        lastDeliveryError: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
}>;
export declare const CronListParamsSchema: import("@sinclair/typebox").TObject<{
    includeDisabled: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    offset: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    query: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    enabled: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"all">, import("@sinclair/typebox").TLiteral<"enabled">, import("@sinclair/typebox").TLiteral<"disabled">]>>;
    sortBy: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"nextRunAtMs">, import("@sinclair/typebox").TLiteral<"updatedAtMs">, import("@sinclair/typebox").TLiteral<"name">]>>;
    sortDir: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"asc">, import("@sinclair/typebox").TLiteral<"desc">]>>;
}>;
export declare const CronStatusParamsSchema: import("@sinclair/typebox").TObject<{}>;
export declare const CronAddParamsSchema: import("@sinclair/typebox").TObject<{
    schedule: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
        kind: import("@sinclair/typebox").TLiteral<"at">;
        at: import("@sinclair/typebox").TString;
    }>, import("@sinclair/typebox").TObject<{
        kind: import("@sinclair/typebox").TLiteral<"every">;
        everyMs: import("@sinclair/typebox").TInteger;
        anchorMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>, import("@sinclair/typebox").TObject<{
        kind: import("@sinclair/typebox").TLiteral<"cron">;
        expr: import("@sinclair/typebox").TString;
        tz: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        staggerMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>]>;
    sessionTarget: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"main">, import("@sinclair/typebox").TLiteral<"isolated">]>;
    wakeMode: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"next-heartbeat">, import("@sinclair/typebox").TLiteral<"now">]>;
    payload: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
        kind: import("@sinclair/typebox").TLiteral<"systemEvent">;
        text: import("@sinclair/typebox").TString;
    }>, import("@sinclair/typebox").TObject<{
        kind: import("@sinclair/typebox").TLiteral<"agentTurn">;
        message: TSchema;
        model: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        thinking: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        timeoutSeconds: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        allowUnsafeExternalContent: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        deliver: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        bestEffortDeliver: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    }>]>;
    delivery: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
        to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
        accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        bestEffort: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        mode: import("@sinclair/typebox").TLiteral<"none">;
    }>, import("@sinclair/typebox").TObject<{
        to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
        accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        bestEffort: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        mode: import("@sinclair/typebox").TLiteral<"announce">;
    }>, import("@sinclair/typebox").TObject<{
        to: import("@sinclair/typebox").TString;
        channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
        accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        bestEffort: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        mode: import("@sinclair/typebox").TLiteral<"webhook">;
    }>]>>;
    agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    sessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    description: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    enabled: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    deleteAfterRun: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    name: import("@sinclair/typebox").TString;
}>;
export declare const CronJobPatchSchema: import("@sinclair/typebox").TObject<{
    schedule: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
        kind: import("@sinclair/typebox").TLiteral<"at">;
        at: import("@sinclair/typebox").TString;
    }>, import("@sinclair/typebox").TObject<{
        kind: import("@sinclair/typebox").TLiteral<"every">;
        everyMs: import("@sinclair/typebox").TInteger;
        anchorMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>, import("@sinclair/typebox").TObject<{
        kind: import("@sinclair/typebox").TLiteral<"cron">;
        expr: import("@sinclair/typebox").TString;
        tz: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        staggerMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>]>>;
    sessionTarget: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"main">, import("@sinclair/typebox").TLiteral<"isolated">]>>;
    wakeMode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"next-heartbeat">, import("@sinclair/typebox").TLiteral<"now">]>>;
    payload: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
        kind: import("@sinclair/typebox").TLiteral<"systemEvent">;
        text: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>, import("@sinclair/typebox").TObject<{
        kind: import("@sinclair/typebox").TLiteral<"agentTurn">;
        message: TSchema;
        model: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        thinking: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        timeoutSeconds: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        allowUnsafeExternalContent: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        deliver: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        bestEffortDeliver: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    }>]>>;
    delivery: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
        accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        bestEffort: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        mode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"none">, import("@sinclair/typebox").TLiteral<"announce">, import("@sinclair/typebox").TLiteral<"webhook">]>>;
    }>>;
    state: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        nextRunAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        runningAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        lastRunAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        lastRunStatus: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"ok">, import("@sinclair/typebox").TLiteral<"error">, import("@sinclair/typebox").TLiteral<"skipped">]>>;
        lastStatus: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"ok">, import("@sinclair/typebox").TLiteral<"error">, import("@sinclair/typebox").TLiteral<"skipped">]>>;
        lastError: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        lastDurationMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        consecutiveErrors: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        lastDelivered: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        lastDeliveryStatus: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"delivered">, import("@sinclair/typebox").TLiteral<"not-delivered">, import("@sinclair/typebox").TLiteral<"unknown">, import("@sinclair/typebox").TLiteral<"not-requested">]>>;
        lastDeliveryError: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>;
    agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    sessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    description: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    enabled: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    deleteAfterRun: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const CronUpdateParamsSchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TString;
}>, import("@sinclair/typebox").TObject<{
    jobId: import("@sinclair/typebox").TString;
}>]>;
export declare const CronRemoveParamsSchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TString;
}>, import("@sinclair/typebox").TObject<{
    jobId: import("@sinclair/typebox").TString;
}>]>;
export declare const CronRunParamsSchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TString;
}>, import("@sinclair/typebox").TObject<{
    jobId: import("@sinclair/typebox").TString;
}>]>;
export declare const CronRunsParamsSchema: import("@sinclair/typebox").TObject<{
    scope: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"job">, import("@sinclair/typebox").TLiteral<"all">]>>;
    id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    jobId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    offset: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    statuses: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"ok">, import("@sinclair/typebox").TLiteral<"error">, import("@sinclair/typebox").TLiteral<"skipped">]>>>;
    status: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"all">, import("@sinclair/typebox").TLiteral<"ok">, import("@sinclair/typebox").TLiteral<"error">, import("@sinclair/typebox").TLiteral<"skipped">]>>;
    deliveryStatuses: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"delivered">, import("@sinclair/typebox").TLiteral<"not-delivered">, import("@sinclair/typebox").TLiteral<"unknown">, import("@sinclair/typebox").TLiteral<"not-requested">]>>>;
    deliveryStatus: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"delivered">, import("@sinclair/typebox").TLiteral<"not-delivered">, import("@sinclair/typebox").TLiteral<"unknown">, import("@sinclair/typebox").TLiteral<"not-requested">]>>;
    query: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    sortDir: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"asc">, import("@sinclair/typebox").TLiteral<"desc">]>>;
}>;
export declare const CronRunLogEntrySchema: import("@sinclair/typebox").TObject<{
    ts: import("@sinclair/typebox").TInteger;
    jobId: import("@sinclair/typebox").TString;
    action: import("@sinclair/typebox").TLiteral<"finished">;
    status: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"ok">, import("@sinclair/typebox").TLiteral<"error">, import("@sinclair/typebox").TLiteral<"skipped">]>>;
    error: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    summary: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    delivered: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    deliveryStatus: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"delivered">, import("@sinclair/typebox").TLiteral<"not-delivered">, import("@sinclair/typebox").TLiteral<"unknown">, import("@sinclair/typebox").TLiteral<"not-requested">]>>;
    deliveryError: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    sessionId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    sessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    runAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    durationMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    nextRunAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    model: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    provider: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    usage: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        input_tokens: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        output_tokens: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        total_tokens: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        cache_read_tokens: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        cache_write_tokens: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
    }>>;
    jobName: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
