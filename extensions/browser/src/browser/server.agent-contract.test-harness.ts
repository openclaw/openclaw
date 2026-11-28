/**
 * Agent-contract test harness for starting the Browser control server and
 * posting JSON through a real fetch implementation.
 */
import {
  getBrowserControlServerBaseUrl,
  installBrowserControlServerHooks,
  startBrowserControlServerFromConfig,
} from "./server.control-server.test-harness.js";
import { getBrowserTestFetch } from "./test-support/fetch.js";

type StartupFetch = (
  url: string,
  init: { method: "POST" },
) => Promise<{ json(): Promise<unknown> }>;

/** Installs Browser control-server hooks for agent-contract tests. */
export function installAgentContractHooks() {
  installBrowserControlServerHooks();
}

/** Starts the Browser control server and returns its base URL. */
export async function startServerAndBase(fetch?: StartupFetch): Promise<string> {
  const started = await startBrowserControlServerFromConfig();
  if (!started?.server?.listening) {
    throw new Error("Browser control server did not start its HTTP listener");
  }
  const base = getBrowserControlServerBaseUrl();
  const realFetch = fetch ?? getBrowserTestFetch();
  const response = await realFetch(`${base}/start`, { method: "POST" });
  await response.json();
  return base;
}

/** Posts JSON to a Browser control-server route and parses the JSON response. */
export async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const realFetch = getBrowserTestFetch();
  const res = await realFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as T;
}
