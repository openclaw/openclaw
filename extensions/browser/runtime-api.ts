export { createBrowserToolDefinition } from "./src/browser-tool-description.js";
export {
  createAttachedBrowserToolRuntime,
  type AttachedBrowserToolRuntime,
  type CreateAttachedBrowserToolRuntimeParams,
} from "./src/attached-browser-tool-runtime.js";
export type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
export { resolveExistingPathsWithinRoot } from "./src/browser/paths.js";
export { browserHandlers } from "./src/gateway/browser-request.js";
