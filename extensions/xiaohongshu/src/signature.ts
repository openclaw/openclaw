import { readFileSync } from "node:fs";
import vm from "node:vm";

let cachedContext: vm.Context | undefined;

function getContext(): vm.Context {
  if (cachedContext) return cachedContext;
  const js = readFileSync(new URL("./vendor/xhsvm.js", import.meta.url), "utf-8");
  // xhsvm.js opens with `window = global; delete global; ...` and sets up
  // browser-like stubs (document, navigator, screen, etc.) on `window`.
  // We provide `global` pointing at the sandbox itself so those assignments work.
  // Silent console to suppress xhsvm.js internal debug logs (createElement, etc.)
  const noop = () => {};
  const silentConsole = { log: noop, warn: noop, error: noop, info: noop, debug: noop };

  const sandbox: Record<string, unknown> = {
    console: silentConsole,
    setTimeout,
    setInterval,
    clearTimeout,
    clearInterval,
    Buffer,
    JSON,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    RegExp,
    Error,
    TypeError,
    RangeError,
    isNaN,
    isFinite,
    undefined,
    NaN,
    Infinity,
  };
  sandbox.global = sandbox;
  cachedContext = vm.createContext(sandbox);
  vm.runInContext(js, cachedContext);
  return cachedContext;
}

/**
 * Generate x-s and x-t signature headers for Xiaohongshu API requests.
 * Delegates to the vendored xhsvm.js (V1) running inside a Node.js VM sandbox.
 */
export function getXsXt(uri: string, data: unknown, cookie: string): { xs: string; xt: number } {
  const ctx = getContext();
  const raw = vm.runInContext(
    `GetXsXt(${JSON.stringify(uri)}, ${JSON.stringify(data)}, ${JSON.stringify(cookie)})`,
    ctx,
  ) as string;
  const parsed = JSON.parse(raw) as { "X-s": string; "X-t": number };
  return { xs: parsed["X-s"], xt: parsed["X-t"] };
}
