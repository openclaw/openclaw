import { i as OpenClawConfig } from "../../types.openclaw-CQzDxdpQ.js";
import { a as SsrFBlockedError, o as SsrFPolicy, p as isBlockedHostnameOrIp, t as LookupFn } from "../../ssrf-CMKWbO56.js";
import { n as RuntimeEnv } from "../../runtime-dOUD4nei.js";
import { r as ReplyPayload } from "../../reply-payload-DUBNZ2s7.js";
import { n as PluginRuntime } from "../../types-CXGnubLv.js";
import { r as createDedupeCache } from "../../dedupe-Ccn5KUYH.js";
import { a as fetchWithSsrFGuard } from "../../fetch-guard-BzbwrEoM.js";
import { d as ssrfPolicyFromDangerouslyAllowPrivateNetwork, u as ssrfPolicyFromAllowPrivateNetwork } from "../../ssrf-policy-BV3RNBqC.js";
import { t as createLoggerBackedRuntime } from "../../runtime-logger-B7crBvX6.js";
import { t as tlonPlugin } from "../../channel-CD6ilbCd.js";

//#region extensions/tlon/src/runtime.d.ts
declare const setTlonRuntime: (next: PluginRuntime) => void, getTlonRuntime: () => PluginRuntime;
//#endregion
export { type LookupFn, type OpenClawConfig, type ReplyPayload, type RuntimeEnv, SsrFBlockedError, type SsrFPolicy, createDedupeCache, createLoggerBackedRuntime, fetchWithSsrFGuard, isBlockedHostnameOrIp, setTlonRuntime, ssrfPolicyFromAllowPrivateNetwork, ssrfPolicyFromDangerouslyAllowPrivateNetwork, tlonPlugin };