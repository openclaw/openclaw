import { i as OpenClawConfig } from "../../types.openclaw-BMMD0Ykw.js";
import { a as SsrFBlockedError, o as SsrFPolicy, p as isBlockedHostnameOrIp, t as LookupFn } from "../../ssrf-DpkM3iBz.js";
import { n as RuntimeEnv } from "../../runtime-Dnacw8wE.js";
import { r as ReplyPayload } from "../../reply-payload-Dx5_3_RD.js";
import { n as PluginRuntime } from "../../types-1xy7Ddy0.js";
import { r as createDedupeCache } from "../../dedupe-sGpwjHYo.js";
import { a as fetchWithSsrFGuard } from "../../fetch-guard-Dj1fWwLa.js";
import { d as ssrfPolicyFromDangerouslyAllowPrivateNetwork, u as ssrfPolicyFromAllowPrivateNetwork } from "../../ssrf-policy-BK9YFTSQ.js";
import { t as createLoggerBackedRuntime } from "../../runtime-logger-D7EL3a0d.js";
import { t as tlonPlugin } from "../../channel-CEM7Y_x9.js";

//#region extensions/tlon/src/runtime.d.ts
declare const setTlonRuntime: (next: PluginRuntime) => void, getTlonRuntime: () => PluginRuntime;
//#endregion
export { type LookupFn, type OpenClawConfig, type ReplyPayload, type RuntimeEnv, SsrFBlockedError, type SsrFPolicy, createDedupeCache, createLoggerBackedRuntime, fetchWithSsrFGuard, isBlockedHostnameOrIp, setTlonRuntime, ssrfPolicyFromAllowPrivateNetwork, ssrfPolicyFromDangerouslyAllowPrivateNetwork, tlonPlugin };