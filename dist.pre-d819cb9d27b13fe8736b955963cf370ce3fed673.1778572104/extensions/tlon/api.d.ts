import { i as OpenClawConfig } from "../../types.openclaw-BlE9q7jU.js";
import { a as SsrFBlockedError, o as SsrFPolicy, p as isBlockedHostnameOrIp, t as LookupFn } from "../../ssrf-DAZxh7gy.js";
import { n as RuntimeEnv } from "../../runtime-B7xbUSXv.js";
import { r as ReplyPayload } from "../../reply-payload-DdR61wWB.js";
import { n as PluginRuntime } from "../../types-6GKVZ6OQ.js";
import { r as createDedupeCache } from "../../dedupe-BbYOdZxn.js";
import { a as fetchWithSsrFGuard } from "../../fetch-guard-BruMQXri.js";
import { d as ssrfPolicyFromAllowPrivateNetwork, f as ssrfPolicyFromDangerouslyAllowPrivateNetwork } from "../../ssrf-policy-BEVET-dK.js";
import { t as createLoggerBackedRuntime } from "../../runtime-logger-BGi4eTLn.js";
import { t as tlonPlugin } from "../../channel-BZ0mbbyX.js";

//#region extensions/tlon/src/runtime.d.ts
declare const setTlonRuntime: (next: PluginRuntime) => void, getTlonRuntime: () => PluginRuntime;
//#endregion
export { type LookupFn, type OpenClawConfig, type ReplyPayload, type RuntimeEnv, SsrFBlockedError, type SsrFPolicy, createDedupeCache, createLoggerBackedRuntime, fetchWithSsrFGuard, isBlockedHostnameOrIp, setTlonRuntime, ssrfPolicyFromAllowPrivateNetwork, ssrfPolicyFromDangerouslyAllowPrivateNetwork, tlonPlugin };