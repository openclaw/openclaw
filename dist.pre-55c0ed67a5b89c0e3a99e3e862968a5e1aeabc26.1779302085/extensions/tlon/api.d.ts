import { i as OpenClawConfig } from "../../types.openclaw-Cy0U3Gwh.js";
import { a as SsrFBlockedError, o as SsrFPolicy, p as isBlockedHostnameOrIp, t as LookupFn } from "../../ssrf-skjEI_i5.js";
import { n as RuntimeEnv } from "../../runtime-Bxifh4bY.js";
import { r as ReplyPayload } from "../../reply-payload-C0EABIPt.js";
import { n as PluginRuntime } from "../../types-Cffq3lh-.js";
import { r as createDedupeCache } from "../../dedupe-BzAZHq3K.js";
import { a as fetchWithSsrFGuard } from "../../fetch-guard-BgaCy73h.js";
import { d as ssrfPolicyFromDangerouslyAllowPrivateNetwork, u as ssrfPolicyFromAllowPrivateNetwork } from "../../ssrf-policy-CmMtuToN.js";
import { t as createLoggerBackedRuntime } from "../../runtime-logger-BjGNJFh2.js";
import { t as tlonPlugin } from "../../channel-DIS9ho2e.js";

//#region extensions/tlon/src/runtime.d.ts
declare const setTlonRuntime: (next: PluginRuntime) => void, getTlonRuntime: () => PluginRuntime;
//#endregion
export { type LookupFn, type OpenClawConfig, type ReplyPayload, type RuntimeEnv, SsrFBlockedError, type SsrFPolicy, createDedupeCache, createLoggerBackedRuntime, fetchWithSsrFGuard, isBlockedHostnameOrIp, setTlonRuntime, ssrfPolicyFromAllowPrivateNetwork, ssrfPolicyFromDangerouslyAllowPrivateNetwork, tlonPlugin };