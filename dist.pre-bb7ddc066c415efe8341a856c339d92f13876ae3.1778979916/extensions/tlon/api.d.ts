import { i as OpenClawConfig } from "../../types.openclaw-BuKAF4PW.js";
import { a as SsrFBlockedError, o as SsrFPolicy, p as isBlockedHostnameOrIp, t as LookupFn } from "../../ssrf-BDx1bk44.js";
import { n as RuntimeEnv } from "../../runtime-Bnks6ho9.js";
import { r as ReplyPayload } from "../../reply-payload-DyspiWjJ.js";
import { n as PluginRuntime } from "../../types-6l5HWcJc.js";
import { r as createDedupeCache } from "../../dedupe-CddE1JAY.js";
import { a as fetchWithSsrFGuard } from "../../fetch-guard-TqGT2xIt.js";
import { d as ssrfPolicyFromDangerouslyAllowPrivateNetwork, u as ssrfPolicyFromAllowPrivateNetwork } from "../../ssrf-policy-pnMtAH7L.js";
import { t as createLoggerBackedRuntime } from "../../runtime-logger-Bc3mlNOr.js";
import { t as tlonPlugin } from "../../channel-QgQMTaj2.js";

//#region extensions/tlon/src/runtime.d.ts
declare const setTlonRuntime: (next: PluginRuntime) => void, getTlonRuntime: () => PluginRuntime;
//#endregion
export { type LookupFn, type OpenClawConfig, type ReplyPayload, type RuntimeEnv, SsrFBlockedError, type SsrFPolicy, createDedupeCache, createLoggerBackedRuntime, fetchWithSsrFGuard, isBlockedHostnameOrIp, setTlonRuntime, ssrfPolicyFromAllowPrivateNetwork, ssrfPolicyFromDangerouslyAllowPrivateNetwork, tlonPlugin };