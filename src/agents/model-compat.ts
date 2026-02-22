import type { Api, Model } from "@mariozechner/pi-ai";

function isOpenAiCompatibleModel(model: Model<Api>): boolean {
  return model.api === "openai-completions" || model.api === "openai-responses";
}

/**
 * Base URL patterns for providers known to reject the OpenAI "developer" role.
 * These providers implement OpenAI-compatible APIs but only accept the
 * traditional "system" role.
 */
const DEVELOPER_ROLE_UNSUPPORTED_URL_PATTERNS = [
  "api.z.ai",
  "dashscope.aliyuncs.com",
  "portal.qwen.ai",
  "qianfan.baidubce.com",
];

function isDeveloperRoleUnsupportedProvider(model: Model<Api>): boolean {
  const baseUrl = model.baseUrl ?? "";
  if (
    model.provider === "zai" ||
    model.provider === "qwen-portal" ||
    model.provider === "qianfan"
  ) {
    return true;
  }
  return DEVELOPER_ROLE_UNSUPPORTED_URL_PATTERNS.some((pattern) => baseUrl.includes(pattern));
}

export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  if (!isOpenAiCompatibleModel(model) || !isDeveloperRoleUnsupportedProvider(model)) {
    return model;
  }

  const compat = model.compat ?? undefined;
  if (compat?.supportsDeveloperRole === false) {
    return model;
  }

  model.compat = compat
    ? { ...compat, supportsDeveloperRole: false }
    : { supportsDeveloperRole: false };
  return model;
}
