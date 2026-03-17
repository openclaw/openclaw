import { ProxyAgent, fetch as undiciFetch } from "undici";
const proxyCache = /* @__PURE__ */ new Map();
function resolveZaloProxyFetch(proxyUrl) {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) {
    return void 0;
  }
  const cached = proxyCache.get(trimmed);
  if (cached) {
    return cached;
  }
  const agent = new ProxyAgent(trimmed);
  const fetcher = (input, init) => undiciFetch(input, {
    ...init,
    dispatcher: agent
  });
  proxyCache.set(trimmed, fetcher);
  return fetcher;
}
export {
  resolveZaloProxyFetch
};
