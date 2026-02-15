import { AsyncLocalStorage } from "node:async_hooks";

export type FeishuToolContext = {
  channel: "feishu";
  accountId: string;
  sessionKey?: string;
};

const toolContextStorage = new AsyncLocalStorage<FeishuToolContext>();

export function runWithFeishuToolContext<T>(context: FeishuToolContext, fn: () => T): T {
  // Propagate the active Feishu account through async boundaries so tool execution
  // can resolve the correct account without changing OpenClaw core APIs.
  return toolContextStorage.run(context, fn);
}

export function getCurrentFeishuToolContext(): FeishuToolContext | undefined {
  // Returns undefined when execution is outside a message-dispatch context.
  return toolContextStorage.getStore();
}
