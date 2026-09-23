import { createOneTimeTicketStore } from "openclaw/plugin-sdk/websocket-runtime";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";

export type BrowserScreencastTokenParams = {
  profileName: string;
  targetId: string;
  cdpUrl: string;
  ssrfPolicy?: SsrFPolicy;
  maxWidth: number;
  maxHeight: number;
  quality: number;
  lifecycleGeneration: number;
  lifecycleSignal: AbortSignal;
  requesterSignal?: AbortSignal;
  isRequesterCurrent?: () => boolean;
  releaseRequester?: () => void;
  assertCurrent: () => void;
  checkNavigationAllowed: (url: string) => Promise<void>;
};

const tokens = createOneTimeTicketStore<BrowserScreencastTokenParams>({
  ttlMs: 60_000,
  onExpire: (params) => params.releaseRequester?.(),
});

export function mintBrowserScreencastToken(params: BrowserScreencastTokenParams): {
  token: string;
  expiresAtMs: number;
} {
  const release = params.releaseRequester;
  if (release && params.requesterSignal) {
    const signal = params.requesterSignal;
    let released = false;
    const onAbort = () => params.releaseRequester?.();
    params.releaseRequester = () => {
      if (released) {
        return;
      }
      released = true;
      signal.removeEventListener("abort", onAbort);
      release();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      params.releaseRequester();
    }
  }
  return tokens.mint(params, { revokeSignal: params.requesterSignal });
}

export function consumeBrowserScreencastToken(
  token: string,
): BrowserScreencastTokenParams | undefined {
  const params = token === token.trim() ? tokens.consume(token) : undefined;
  if (params && (params.requesterSignal?.aborted || params.isRequesterCurrent?.() === false)) {
    params.releaseRequester?.();
    return undefined;
  }
  return params;
}

export function clearBrowserScreencastTokens(): void {
  tokens.clear();
}
