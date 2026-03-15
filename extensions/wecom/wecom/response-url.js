import { RESPONSE_URL_ERROR_BODY_PREVIEW_MAX } from "./constants.js";

export function normalizeWecomErrcode(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

export function parseResponseUrlResult(response, responseBody) {
  const bodyText = typeof responseBody === "string" ? responseBody.trim() : "";
  let parsed = null;
  if (bodyText) {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = null;
    }
  }
  const errcode = normalizeWecomErrcode(parsed?.errcode);
  const errmsg = typeof parsed?.errmsg === "string" ? parsed.errmsg : "";
  // WeCom response_url should return JSON with errcode=0 when accepted.
  const accepted = response.ok && errcode === 0;
  return {
    accepted,
    errcode,
    errmsg,
    bodyPreview: bodyText.substring(0, RESPONSE_URL_ERROR_BODY_PREVIEW_MAX),
  };
}
