const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const MAX_EXTERNAL_KEY_LENGTH = 512;
function normalizeFeishuExternalKey(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_EXTERNAL_KEY_LENGTH) {
    return void 0;
  }
  if (CONTROL_CHARS_RE.test(normalized)) {
    return void 0;
  }
  if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) {
    return void 0;
  }
  return normalized;
}
export {
  normalizeFeishuExternalKey
};
