import { i as OpenClawConfig } from "../../types.openclaw-DBDmmaVM.js";
import { a as SsrFBlockedError, o as SsrFPolicy, p as isBlockedHostnameOrIp, t as LookupFn } from "../../ssrf-D_7xmVo8.js";
import { n as RuntimeEnv } from "../../runtime-B4p2dmOC.js";
import { r as ReplyPayload } from "../../reply-payload-CNTUnQyV.js";
import { n as PluginRuntime } from "../../types-BkonLdRT.js";
import { r as createDedupeCache } from "../../dedupe-BS9ml386.js";
import { a as fetchWithSsrFGuard } from "../../fetch-guard-HvFp7SHM.js";
import { d as ssrfPolicyFromDangerouslyAllowPrivateNetwork, u as ssrfPolicyFromAllowPrivateNetwork } from "../../ssrf-policy-DhOEsrGd.js";
import { t as createLoggerBackedRuntime } from "../../runtime-logger-CWZ34IQL.js";
import { t as tlonPlugin } from "../../channel-BsZ6YOW5.js";

//#region extensions/tlon/src/runtime.d.ts
declare const setTlonRuntime: (next: PluginRuntime) => void, getTlonRuntime: () => PluginRuntime;
//#endregion
export { type LookupFn, type OpenClawConfig, type ReplyPayload, type RuntimeEnv, SsrFBlockedError, type SsrFPolicy, createDedupeCache, createLoggerBackedRuntime, fetchWithSsrFGuard, isBlockedHostnameOrIp, setTlonRuntime, ssrfPolicyFromAllowPrivateNetwork, ssrfPolicyFromDangerouslyAllowPrivateNetwork, tlonPlugin };