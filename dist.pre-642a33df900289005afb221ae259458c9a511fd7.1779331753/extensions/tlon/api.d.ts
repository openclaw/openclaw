import { i as OpenClawConfig } from "../../types.openclaw-GamulG8g.js";
import { a as SsrFBlockedError, o as SsrFPolicy, p as isBlockedHostnameOrIp, t as LookupFn } from "../../ssrf-skjEI_i5.js";
import { n as RuntimeEnv } from "../../runtime-Bxifh4bY.js";
import { r as ReplyPayload } from "../../reply-payload-BIYe4NOR.js";
import { n as PluginRuntime } from "../../types-AFN3jLI5.js";
import { r as createDedupeCache } from "../../dedupe-BzAZHq3K.js";
import { a as fetchWithSsrFGuard } from "../../fetch-guard-BgaCy73h.js";
import { d as ssrfPolicyFromDangerouslyAllowPrivateNetwork, u as ssrfPolicyFromAllowPrivateNetwork } from "../../ssrf-policy-BZ-UtAYK.js";
import { t as createLoggerBackedRuntime } from "../../runtime-logger-BjGNJFh2.js";
import { t as tlonPlugin } from "../../channel-WVt5vwCO.js";

//#region extensions/tlon/src/runtime.d.ts
declare const setTlonRuntime: (next: PluginRuntime) => void, getTlonRuntime: () => PluginRuntime;
//#endregion
export { type LookupFn, type OpenClawConfig, type ReplyPayload, type RuntimeEnv, SsrFBlockedError, type SsrFPolicy, createDedupeCache, createLoggerBackedRuntime, fetchWithSsrFGuard, isBlockedHostnameOrIp, setTlonRuntime, ssrfPolicyFromAllowPrivateNetwork, ssrfPolicyFromDangerouslyAllowPrivateNetwork, tlonPlugin };