/**
 * Re-exports from the Control4 extension — single import surface for all server routes.
 * Uses relative paths since the path alias (@c4) is a Vite/TS alias not available at runtime.
 */
export {
  getItems,
  getVariables,
  sendCommand,
  getUiConfiguration,
  invalidateItemsCache,
  type C4Item,
  type C4Variable,
} from "../../extensions/control4/src/client.js";

export {
  buildControl4Prompt,
  invalidatePromptCache,
} from "../../extensions/control4/src/prompt.js";

export { getDirectorToken } from "../../extensions/control4/src/auth.js";
