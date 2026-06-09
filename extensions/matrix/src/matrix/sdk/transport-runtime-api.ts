// Matrix API module exposes the plugin public contract.
import { fetchWithRuntimeDispatcherOrMockedGlobal } from "openclaw/plugin-sdk/runtime-fetch";
import {
  closeDispatcher,
  createPinnedDispatcher,
  resolvePinnedHostnameWithPolicy,
  type PinnedDispatcherPolicy,
} from "openclaw/plugin-sdk/ssrf-dispatcher";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-policy";
export { buildTimeoutAbortSignal } from "./timeout-abort-signal.js";

export {
  closeDispatcher,
  createPinnedDispatcher,
  fetchWithRuntimeDispatcherOrMockedGlobal,
  resolvePinnedHostnameWithPolicy,
  type PinnedDispatcherPolicy,
  type SsrFPolicy,
};
