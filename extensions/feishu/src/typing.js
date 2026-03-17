import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { getFeishuRuntime } from "./runtime.js";
const TYPING_EMOJI = "Typing";
const FEISHU_BACKOFF_CODES = /* @__PURE__ */ new Set([99991400, 99991403, 429]);
class FeishuBackoffError extends Error {
  constructor(code) {
    super(`Feishu API backoff: code ${code}`);
    this.name = "FeishuBackoffError";
    this.code = code;
  }
}
function isFeishuBackoffError(err) {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const response = err.response;
  if (response) {
    if (response.status === 429) {
      return true;
    }
    if (typeof response.data?.code === "number" && FEISHU_BACKOFF_CODES.has(response.data.code)) {
      return true;
    }
  }
  const code = err.code;
  if (typeof code === "number" && FEISHU_BACKOFF_CODES.has(code)) {
    return true;
  }
  return false;
}
function getBackoffCodeFromResponse(response) {
  if (typeof response !== "object" || response === null) {
    return void 0;
  }
  const code = response.code;
  if (typeof code === "number" && FEISHU_BACKOFF_CODES.has(code)) {
    return code;
  }
  return void 0;
}
async function addTypingIndicator(params) {
  const { cfg, messageId, accountId, runtime } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    return { messageId, reactionId: null };
  }
  const client = createFeishuClient(account);
  try {
    const response = await client.im.messageReaction.create({
      path: { message_id: messageId },
      data: {
        reaction_type: { emoji_type: TYPING_EMOJI }
      }
    });
    const backoffCode = getBackoffCodeFromResponse(response);
    if (backoffCode !== void 0) {
      if (getFeishuRuntime().logging.shouldLogVerbose()) {
        runtime?.log?.(
          `[feishu] typing indicator response contains backoff code ${backoffCode}, stopping keepalive`
        );
      }
      throw new FeishuBackoffError(backoffCode);
    }
    const reactionId = response?.data?.reaction_id ?? null;
    return { messageId, reactionId };
  } catch (err) {
    if (isFeishuBackoffError(err)) {
      if (getFeishuRuntime().logging.shouldLogVerbose()) {
        runtime?.log?.("[feishu] typing indicator hit rate-limit/quota, stopping keepalive");
      }
      throw err;
    }
    if (getFeishuRuntime().logging.shouldLogVerbose()) {
      runtime?.log?.(`[feishu] failed to add typing indicator: ${String(err)}`);
    }
    return { messageId, reactionId: null };
  }
}
async function removeTypingIndicator(params) {
  const { cfg, state, accountId, runtime } = params;
  if (!state.reactionId) {
    return;
  }
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    return;
  }
  const client = createFeishuClient(account);
  try {
    const result = await client.im.messageReaction.delete({
      path: {
        message_id: state.messageId,
        reaction_id: state.reactionId
      }
    });
    const backoffCode = getBackoffCodeFromResponse(result);
    if (backoffCode !== void 0) {
      if (getFeishuRuntime().logging.shouldLogVerbose()) {
        runtime?.log?.(
          `[feishu] typing indicator removal response contains backoff code ${backoffCode}, stopping keepalive`
        );
      }
      throw new FeishuBackoffError(backoffCode);
    }
  } catch (err) {
    if (isFeishuBackoffError(err)) {
      if (getFeishuRuntime().logging.shouldLogVerbose()) {
        runtime?.log?.(
          "[feishu] typing indicator removal hit rate-limit/quota, stopping keepalive"
        );
      }
      throw err;
    }
    if (getFeishuRuntime().logging.shouldLogVerbose()) {
      runtime?.log?.(`[feishu] failed to remove typing indicator: ${String(err)}`);
    }
  }
}
export {
  FeishuBackoffError,
  addTypingIndicator,
  getBackoffCodeFromResponse,
  isFeishuBackoffError,
  removeTypingIndicator
};
