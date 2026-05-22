//#region extensions/feishu/src/subagent-hooks.d.ts
type FeishuSubagentContext = {
  requesterSessionKey?: string;
};
type FeishuSubagentSpawningEvent = {
  threadRequested?: boolean;
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  childSessionKey: string;
  agentId?: string;
  label?: string;
};
type FeishuSubagentDeliveryTargetEvent = {
  expectsCompletionMessage?: boolean;
  requesterOrigin?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  childSessionKey: string;
  requesterSessionKey?: string;
};
type FeishuSubagentEndedEvent = {
  accountId?: string;
  targetSessionKey: string;
};
type FeishuSubagentSpawningResult = {
  status: "ok";
  threadBindingReady?: boolean;
  deliveryOrigin?: {
    channel: "feishu";
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
} | {
  status: "error";
  error: string;
} | undefined;
type FeishuSubagentDeliveryTargetResult = {
  origin: {
    channel: "feishu";
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
} | undefined;
declare function handleFeishuSubagentSpawning(event: FeishuSubagentSpawningEvent, ctx: FeishuSubagentContext): Promise<FeishuSubagentSpawningResult>;
declare function handleFeishuSubagentDeliveryTarget(event: FeishuSubagentDeliveryTargetEvent): FeishuSubagentDeliveryTargetResult;
declare function handleFeishuSubagentEnded(event: FeishuSubagentEndedEvent): void;
//#endregion
export { handleFeishuSubagentEnded as n, handleFeishuSubagentSpawning as r, handleFeishuSubagentDeliveryTarget as t };