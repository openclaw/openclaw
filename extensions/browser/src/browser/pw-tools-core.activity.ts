import type { Page } from "playwright-core";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import type {
  BrowserConsoleMessage,
  BrowserNetworkRequest,
  BrowserPageError,
} from "./pw-session.js";
import { ensurePageState } from "./pw-session.js";
import { getAllowedPageForTarget } from "./pw-tools-core.followup-guard.js";

export async function getPageErrorsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  clear?: boolean;
  page?: Page;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{ errors: BrowserPageError[] }> {
  const page = await getAllowedPageForTarget(opts);
  const state = ensurePageState(page);
  const errors = [...state.errors];
  if (opts.clear) {
    state.errors = [];
  }
  return { errors };
}

export async function getNetworkRequestsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  filter?: string;
  clear?: boolean;
  page?: Page;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{ requests: BrowserNetworkRequest[] }> {
  const page = await getAllowedPageForTarget(opts);
  const state = ensurePageState(page);
  const raw = [...state.requests];
  const filter = typeof opts.filter === "string" ? opts.filter.trim() : "";
  const requests = filter ? raw.filter((r) => r.url.includes(filter)) : raw;
  if (opts.clear) {
    state.requests = [];
    state.requestIds = new WeakMap();
  }
  return { requests };
}

function consolePriority(level: string) {
  switch (level) {
    case "error":
      return 3;
    case "warning":
      return 2;
    case "info":
    case "log":
      return 1;
    case "debug":
      return 0;
    default:
      return 1;
  }
}

export async function getConsoleMessagesViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  level?: string;
  page?: Page;
  ssrfPolicy?: SsrFPolicy;
}): Promise<BrowserConsoleMessage[]> {
  const page = await getAllowedPageForTarget(opts);
  const state = ensurePageState(page);
  if (!opts.level) {
    return [...state.console];
  }
  const min = consolePriority(opts.level);
  return state.console.filter((msg) => consolePriority(msg.type) >= min);
}
