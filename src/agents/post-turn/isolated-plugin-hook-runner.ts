import type {
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginHookLlmOutputEvent,
} from "../../plugins/hook-types.js";
import { runPostTurnWorkerProcess } from "./worker-process.js";

const DIST_WORKER_ENTRY_RELATIVE_URL = "./agents/post-turn/isolated-plugin-hook-worker-entry.js";

function resolveIsolatedPostTurnPluginHookWorkerModuleUrl(): string {
  const configured = process.env.OPENCLAW_POST_TURN_HOOK_WORKER_MODULE_URL?.trim();
  if (configured) {
    return configured;
  }
  return new URL(DIST_WORKER_ENTRY_RELATIVE_URL, import.meta.url).href;
}

export type IsolatedPostTurnPluginHookRequest =
  | {
      hookName: "agent_end";
      pluginId: string;
      registrationOrdinal: number;
      event: PluginHookAgentEndEvent;
      ctx: PluginHookAgentContext;
    }
  | {
      hookName: "llm_output";
      pluginId: string;
      registrationOrdinal: number;
      event: PluginHookLlmOutputEvent;
      ctx: PluginHookAgentContext;
    };

export async function runIsolatedPostTurnPluginHook(params: {
  request: IsolatedPostTurnPluginHookRequest;
  timeoutMs?: number;
}): Promise<void> {
  await runPostTurnWorkerProcess({
    workerModuleUrl: resolveIsolatedPostTurnPluginHookWorkerModuleUrl(),
    request: params.request,
    timeoutMs: params.timeoutMs,
  });
}
