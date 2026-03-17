const DEFAULT_TIMEOUT_MS = 1e4;
function normalizeBlueBubblesServerUrl(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("BlueBubbles serverUrl is required");
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}
function buildBlueBubblesApiUrl(params) {
  const normalized = normalizeBlueBubblesServerUrl(params.baseUrl);
  const url = new URL(params.path, `${normalized}/`);
  if (params.password) {
    url.searchParams.set("password", params.password);
  }
  return url.toString();
}
async function blueBubblesFetchWithTimeout(url, init, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
export {
  blueBubblesFetchWithTimeout,
  buildBlueBubblesApiUrl,
  normalizeBlueBubblesServerUrl
};
