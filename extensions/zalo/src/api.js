const ZALO_API_BASE = "https://bot-api.zaloplatforms.com";
class ZaloApiError extends Error {
  constructor(message, errorCode, description) {
    super(message);
    this.errorCode = errorCode;
    this.description = description;
    this.name = "ZaloApiError";
  }
  /** True if this is a long-polling timeout (no updates available) */
  get isPollingTimeout() {
    return this.errorCode === 408;
  }
}
async function callZaloApi(method, token, body, options) {
  const url = `${ZALO_API_BASE}/bot${token}/${method}`;
  const controller = new AbortController();
  const timeoutId = options?.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : void 0;
  const fetcher = options?.fetch ?? fetch;
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : void 0,
      signal: controller.signal
    });
    const data = await response.json();
    if (!data.ok) {
      throw new ZaloApiError(
        data.description ?? `Zalo API error: ${method}`,
        data.error_code,
        data.description
      );
    }
    return data;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
async function getMe(token, timeoutMs, fetcher) {
  return callZaloApi("getMe", token, void 0, { timeoutMs, fetch: fetcher });
}
async function sendMessage(token, params, fetcher) {
  return callZaloApi("sendMessage", token, params, { fetch: fetcher });
}
async function sendPhoto(token, params, fetcher) {
  return callZaloApi("sendPhoto", token, params, { fetch: fetcher });
}
async function sendChatAction(token, params, fetcher, timeoutMs) {
  return callZaloApi("sendChatAction", token, params, {
    timeoutMs,
    fetch: fetcher
  });
}
async function getUpdates(token, params, fetcher) {
  const pollTimeoutSec = params?.timeout ?? 30;
  const timeoutMs = (pollTimeoutSec + 5) * 1e3;
  const body = { timeout: String(pollTimeoutSec) };
  return callZaloApi("getUpdates", token, body, { timeoutMs, fetch: fetcher });
}
async function setWebhook(token, params, fetcher) {
  return callZaloApi("setWebhook", token, params, { fetch: fetcher });
}
async function deleteWebhook(token, fetcher, timeoutMs) {
  return callZaloApi("deleteWebhook", token, void 0, {
    timeoutMs,
    fetch: fetcher
  });
}
async function getWebhookInfo(token, fetcher) {
  return callZaloApi("getWebhookInfo", token, void 0, { fetch: fetcher });
}
export {
  ZaloApiError,
  callZaloApi,
  deleteWebhook,
  getMe,
  getUpdates,
  getWebhookInfo,
  sendChatAction,
  sendMessage,
  sendPhoto,
  setWebhook
};
