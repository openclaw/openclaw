// Tlon API module exposes the plugin public contract.
export {
  createDedupeCache,
  createLoggerBackedRuntime,
  type OpenClawConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "./runtime-api.js";
export { tlonPlugin } from "./src/channel.js";
export { setTlonRuntime } from "./src/runtime.js";
