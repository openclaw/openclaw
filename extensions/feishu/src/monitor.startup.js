import { probeFeishu } from "./probe.js";
const FEISHU_STARTUP_BOT_INFO_TIMEOUT_MS = 1e4;
function isTimeoutErrorMessage(message) {
  return message?.toLowerCase().includes("timeout") || message?.toLowerCase().includes("timed out") ? true : false;
}
function isAbortErrorMessage(message) {
  return message?.toLowerCase().includes("aborted") ?? false;
}
async function fetchBotIdentityForMonitor(account, options = {}) {
  if (options.abortSignal?.aborted) {
    return {};
  }
  const timeoutMs = options.timeoutMs ?? FEISHU_STARTUP_BOT_INFO_TIMEOUT_MS;
  const result = await probeFeishu(account, {
    timeoutMs,
    abortSignal: options.abortSignal
  });
  if (result.ok) {
    return { botOpenId: result.botOpenId, botName: result.botName };
  }
  if (options.abortSignal?.aborted || isAbortErrorMessage(result.error)) {
    return {};
  }
  if (isTimeoutErrorMessage(result.error)) {
    const error = options.runtime?.error ?? console.error;
    error(
      `feishu[${account.accountId}]: bot info probe timed out after ${timeoutMs}ms; continuing startup`
    );
  }
  return {};
}
async function fetchBotOpenIdForMonitor(account, options = {}) {
  const identity = await fetchBotIdentityForMonitor(account, options);
  return identity.botOpenId;
}
export {
  FEISHU_STARTUP_BOT_INFO_TIMEOUT_MS,
  fetchBotIdentityForMonitor,
  fetchBotOpenIdForMonitor
};
