import { i as OpenClawConfig } from "../../types.openclaw-BYfkTL_f.js";
import { a as SsrFBlockedError, o as SsrFPolicy, p as isBlockedHostnameOrIp, t as LookupFn } from "../../ssrf-HuuPklwv.js";
import { n as RuntimeEnv } from "../../runtime-BGFXd35m.js";
import { r as ReplyPayload } from "../../reply-payload-DpKGqclz.js";
import { n as PluginRuntime } from "../../types-PzLD5nJ3.js";
import { r as createDedupeCache } from "../../dedupe-DsSKRf_Q.js";
import { a as fetchWithSsrFGuard } from "../../fetch-guard-C1kYqyXr.js";
import { d as ssrfPolicyFromDangerouslyAllowPrivateNetwork, u as ssrfPolicyFromAllowPrivateNetwork } from "../../ssrf-policy-4y8Ddtgi.js";
import { t as createLoggerBackedRuntime } from "../../runtime-logger-DwM0bk6h.js";
import { t as tlonPlugin } from "../../channel-DM9T_mS1.js";

//#region extensions/tlon/src/runtime.d.ts
declare const setTlonRuntime: (next: PluginRuntime) => void, getTlonRuntime: () => PluginRuntime;
//#endregion
export { type LookupFn, type OpenClawConfig, type ReplyPayload, type RuntimeEnv, SsrFBlockedError, type SsrFPolicy, createDedupeCache, createLoggerBackedRuntime, fetchWithSsrFGuard, isBlockedHostnameOrIp, setTlonRuntime, ssrfPolicyFromAllowPrivateNetwork, ssrfPolicyFromDangerouslyAllowPrivateNetwork, tlonPlugin };