import { nativeWebSearchCodecs } from "openclaw/plugin-sdk/provider-web-search";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClawRouterCapabilityOffer } from "./capability-offers.js";

export function isDeepSeekSearchOffer(offer: ClawRouterCapabilityOffer): boolean {
  return (
    offer.providerId === "deepseek" &&
    offer.model === undefined &&
    offer.path === "/v1/tools/search" &&
    offer.requestFormat === "deepseek.search" &&
    offer.responseFormat === "deepseek.search" &&
    offer.methods.includes("POST") &&
    (offer.routeKind === "native" || offer.routeKind === "manifest")
  );
}

export function assertDeepSeekSearchInput(args: Record<string, unknown>, query: string): void {
  if (/\p{Surrogate}/u.test(query) || !query.trim() || Array.from(query).length > 128) {
    throw new Error("ClawRouter DeepSeek search requires 1-128 Unicode query characters");
  }
  // Only the frozen unary query/count contract is qualified. Never silently drop
  // filters, request full-page content, or fall back to Chat for unsupported input.
  if (Object.keys(args).some((key) => key !== "query" && key !== "count")) {
    throw new Error("ClawRouter DeepSeek search supports only query and count");
  }
}

export function assertDeepSeekSearchResponse(response: Response): void {
  const mime = response.headers.get("content-type");
  const encoding = response.headers.get("content-encoding");
  if (
    response.status !== 200 ||
    response.redirected ||
    response.headers.has("content-range") ||
    !mime ||
    !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(mime.trim()) ||
    (encoding !== null && encoding.trim().toLowerCase() !== "identity")
  ) {
    throw new Error("ClawRouter DeepSeek search requires a complete native JSON response");
  }
}

export function assertDeepSeekSearchResults(payload: unknown, count: number): void {
  const rows = asOptionalRecord(payload)?.results;
  if (!Array.isArray(rows) || rows.length > count) {
    throw new Error("ClawRouter DeepSeek search returned an invalid result count");
  }
  const decoded = nativeWebSearchCodecs["deepseek.search"].readResults(payload, count);
  if (
    decoded.omittedResults ||
    decoded.results.some((row) => {
      const url = new URL(row.url);
      return url.username !== "" || url.password !== "";
    })
  ) {
    throw new Error("ClawRouter DeepSeek search returned an unsafe result URL");
  }
}
