import { i as OpenClawConfig } from "../../types.openclaw-C9E_zZnO.js";
import { a as SsrFBlockedError, o as SsrFPolicy, p as isBlockedHostnameOrIp, t as LookupFn } from "../../ssrf-D3pufDBY.js";
import { n as RuntimeEnv } from "../../runtime-D0p4Vp8x.js";
import { r as ReplyPayload } from "../../reply-payload-lhKzevm6.js";
import { n as PluginRuntime } from "../../types-C2b0JJwH.js";
import { r as createDedupeCache } from "../../dedupe-CWQ-7-4H.js";
import { a as fetchWithSsrFGuard } from "../../fetch-guard-CxM_5XQX.js";
import { d as ssrfPolicyFromAllowPrivateNetwork, f as ssrfPolicyFromDangerouslyAllowPrivateNetwork } from "../../ssrf-policy-b5jctt9M.js";
import { t as createLoggerBackedRuntime } from "../../runtime-logger-BuV8HhDb.js";
import { t as tlonPlugin } from "../../channel-DpxXUhoL.js";

//#region extensions/tlon/src/runtime.d.ts
declare const setTlonRuntime: (next: PluginRuntime) => void, getTlonRuntime: () => PluginRuntime;
//#endregion
export { type LookupFn, type OpenClawConfig, type ReplyPayload, type RuntimeEnv, SsrFBlockedError, type SsrFPolicy, createDedupeCache, createLoggerBackedRuntime, fetchWithSsrFGuard, isBlockedHostnameOrIp, setTlonRuntime, ssrfPolicyFromAllowPrivateNetwork, ssrfPolicyFromDangerouslyAllowPrivateNetwork, tlonPlugin };