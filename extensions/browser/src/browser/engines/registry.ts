import { chromiumEngine } from "./chromium.js";
import { lightpandaEngine } from "./lightpanda.js";
import type { BrowserEngineAdapter, BrowserEngineDescriptor, BrowserEngineId } from "./types.js";

// The Browser plugin owns this fixed registry. Register both implementations
// here; selection never loads a second tool, process manager, or plugin runtime.
const engines: Readonly<Record<BrowserEngineId, BrowserEngineAdapter>> = {
  chromium: chromiumEngine,
  lightpanda: lightpandaEngine,
};

export function resolveBrowserEngine(id: BrowserEngineId = "chromium"): BrowserEngineAdapter {
  if (!Object.hasOwn(engines, id)) {
    throw new Error(`Unknown browser engine "${id}". Select chromium or lightpanda.`);
  }
  return engines[id];
}

/** The same registered implementations drive status discovery and execution. */
export function listBrowserEngines(): BrowserEngineDescriptor[] {
  return Object.values(engines).map(({ descriptor }) => Object.assign({}, descriptor));
}
