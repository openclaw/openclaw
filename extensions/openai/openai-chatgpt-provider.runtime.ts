import { ensureGlobalUndiciEnvProxyDispatcher } from "openclaw/plugin-sdk/runtime-env";
import { refreshOpenAICodexToken as refreshOpenAICodexTokenFromFlow } from "./openai-chatgpt-oauth-flow.runtime.js";

export async function refreshOpenAICodexToken(
  ...args: Parameters<typeof refreshOpenAICodexTokenFromFlow>
): Promise<Awaited<ReturnType<typeof refreshOpenAICodexTokenFromFlow>>> {
  ensureGlobalUndiciEnvProxyDispatcher();
  return await refreshOpenAICodexTokenFromFlow(...args);
}
