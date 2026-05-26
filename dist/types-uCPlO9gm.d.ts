//#region src/auto-reply/reply/queue/types.d.ts
type QueueMode = "steer" | "followup" | "collect" | "interrupt";
type QueueDropPolicy = "old" | "new" | "summarize";
//#endregion
export { QueueMode as n, QueueDropPolicy as t };