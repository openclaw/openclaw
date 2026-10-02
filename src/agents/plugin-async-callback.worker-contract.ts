import type { OpenClawPluginAsyncToolCallbackStatus } from "../plugins/tool-types.js";
import type { PluginAsyncCallbackBinding } from "./plugin-async-callback-policy.js";
import type {
  PluginAsyncCallbackSettlement,
  PluginAsyncCallbackCompletion,
} from "./plugin-async-callback.store.js";

export type PluginAsyncCallbackWorkerOperations = {
  "pluginCallback.status": {
    input: { token: string; binding: PluginAsyncCallbackBinding };
    output: OpenClawPluginAsyncToolCallbackStatus;
  };
  "pluginCallback.settle": { input: PluginAsyncCallbackSettlement; output: void };
  "pluginCallback.expire": { input: { key: string }; output: boolean };
  "pluginCallback.lookup": {
    input: { token: string };
    output:
      | (PluginAsyncCallbackBinding & { status: "pending" | "completed" | "cancelled" | "expired" })
      | undefined;
  };
  "pluginCallback.issue": {
    input: { binding: PluginAsyncCallbackBinding; ttlMs: number };
    output: { token: string; expiresAt: number; queueId: string };
  };
  "pluginCallback.complete": {
    input: { token: string; resultText: string; binding: PluginAsyncCallbackBinding };
    output: PluginAsyncCallbackCompletion;
  };
  "pluginCallback.cancel": {
    input: { token: string; binding: PluginAsyncCallbackBinding };
    output: "cancelled" | "completed" | "unknown";
  };
};

export function isPluginAsyncCallbackCommand(command: { type: string }): command is {
  [K in keyof PluginAsyncCallbackWorkerOperations]: {
    type: K;
    input: PluginAsyncCallbackWorkerOperations[K]["input"];
  };
}[keyof PluginAsyncCallbackWorkerOperations] {
  return (
    command.type === "pluginCallback.status" ||
    command.type === "pluginCallback.settle" ||
    command.type === "pluginCallback.expire" ||
    command.type === "pluginCallback.issue" ||
    command.type === "pluginCallback.lookup" ||
    command.type === "pluginCallback.complete" ||
    command.type === "pluginCallback.cancel"
  );
}
