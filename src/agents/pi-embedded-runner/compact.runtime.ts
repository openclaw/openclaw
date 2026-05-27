import { compactEmbeddedPiSessionDirect as compactEmbeddedPiSessionDirectImpl } from "./compact.js";

type CompactEmbeddedPiSessionDirect = typeof import("./compact.js").compactEmbeddedPiSessionDirect;

export function compactEmbeddedPiSessionDirect(
  ...args: Parameters<CompactEmbeddedPiSessionDirect>
): ReturnType<CompactEmbeddedPiSessionDirect> {
  return compactEmbeddedPiSessionDirectImpl(...args);
}
