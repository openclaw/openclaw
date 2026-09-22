// Matrix API module exposes the plugin public contract.
export { fetchWithRuntimeDispatcherOrMockedGlobal } from "openclaw/plugin-sdk/runtime-fetch";
export {
  closeDispatcher,
  createPinnedDispatcher,
  resolvePinnedHostnameWithPolicy,
  type PinnedDispatcherPolicy,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-dispatcher";
export { buildTimeoutAbortSignal } from "./timeout-abort-signal.js";
