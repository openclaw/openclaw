import { i as OpenClawConfig } from "../../types.openclaw-D8bJSZjd.js";
import { a as SsrFBlockedError, o as SsrFPolicy, p as isBlockedHostnameOrIp, t as LookupFn } from "../../ssrf-B895VXNy.js";
import { n as RuntimeEnv } from "../../runtime-gBwJlInh.js";
import { r as ReplyPayload } from "../../reply-payload-NB2y3Iea.js";
import { n as PluginRuntime } from "../../types-DBMmCO8F.js";
import { r as createDedupeCache } from "../../dedupe-DZddO8mt.js";
import { a as fetchWithSsrFGuard } from "../../fetch-guard-CwCJqokG.js";
import { d as ssrfPolicyFromDangerouslyAllowPrivateNetwork, u as ssrfPolicyFromAllowPrivateNetwork } from "../../ssrf-policy-Cd5bN6LH.js";
import { t as createLoggerBackedRuntime } from "../../runtime-logger-BOXBdeLz.js";
import { t as tlonPlugin } from "../../channel-DMteYNvY.js";

//#region extensions/tlon/src/runtime.d.ts
declare const setTlonRuntime: (next: PluginRuntime) => void, getTlonRuntime: () => PluginRuntime;
//#endregion
export { type LookupFn, type OpenClawConfig, type ReplyPayload, type RuntimeEnv, SsrFBlockedError, type SsrFPolicy, createDedupeCache, createLoggerBackedRuntime, fetchWithSsrFGuard, isBlockedHostnameOrIp, setTlonRuntime, ssrfPolicyFromAllowPrivateNetwork, ssrfPolicyFromDangerouslyAllowPrivateNetwork, tlonPlugin };