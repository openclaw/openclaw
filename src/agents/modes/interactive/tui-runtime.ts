import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Terminal renderers are synchronous; headless sessions never need this runtime. */
export function loadTuiRuntime(): typeof import("@earendil-works/pi-tui") {
  // SAFETY: The pinned package's public root supplies this synchronous API.
  return require("@earendil-works/pi-tui") as typeof import("@earendil-works/pi-tui");
}
