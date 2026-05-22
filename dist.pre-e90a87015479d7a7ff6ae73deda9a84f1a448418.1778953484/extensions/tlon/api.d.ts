import { i as OpenClawConfig } from "../../types.openclaw-DNoZmPZ8.js";
import { a as SsrFBlockedError, o as SsrFPolicy, p as isBlockedHostnameOrIp, t as LookupFn } from "../../ssrf-B_L-my6p.js";
import { n as RuntimeEnv } from "../../runtime-dC5rwQf_.js";
import { r as ReplyPayload } from "../../reply-payload-ClVTZTBq.js";
import { n as PluginRuntime } from "../../types-DLVUU0yv.js";
import { r as createDedupeCache } from "../../dedupe-CMopEGa_.js";
import { a as fetchWithSsrFGuard } from "../../fetch-guard-DUdL1KNr.js";
import { d as ssrfPolicyFromAllowPrivateNetwork, f as ssrfPolicyFromDangerouslyAllowPrivateNetwork } from "../../ssrf-policy-D8isaSyF.js";
import { t as createLoggerBackedRuntime } from "../../runtime-logger-DwgLqo7P.js";
import { t as tlonPlugin } from "../../channel-CVsfJgmm.js";

//#region extensions/tlon/src/runtime.d.ts
declare const setTlonRuntime: (next: PluginRuntime) => void, getTlonRuntime: () => PluginRuntime;
//#endregion
export { type LookupFn, type OpenClawConfig, type ReplyPayload, type RuntimeEnv, SsrFBlockedError, type SsrFPolicy, createDedupeCache, createLoggerBackedRuntime, fetchWithSsrFGuard, isBlockedHostnameOrIp, setTlonRuntime, ssrfPolicyFromAllowPrivateNetwork, ssrfPolicyFromDangerouslyAllowPrivateNetwork, tlonPlugin };