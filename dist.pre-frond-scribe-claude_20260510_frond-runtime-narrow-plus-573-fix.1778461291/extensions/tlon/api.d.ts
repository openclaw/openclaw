import { i as OpenClawConfig } from "../../types.openclaw-CoVv5VQR.js";
import { a as SsrFBlockedError, o as SsrFPolicy, p as isBlockedHostnameOrIp, t as LookupFn } from "../../ssrf-Bd7A979_.js";
import { n as RuntimeEnv } from "../../runtime-lEKWbTQa.js";
import { r as ReplyPayload } from "../../reply-payload-DxNjvRBt.js";
import { n as PluginRuntime } from "../../types-DVhGJHIy.js";
import { r as createDedupeCache } from "../../dedupe-s3MqgVdx.js";
import { a as fetchWithSsrFGuard } from "../../fetch-guard-45eN-jyu.js";
import { d as ssrfPolicyFromAllowPrivateNetwork, f as ssrfPolicyFromDangerouslyAllowPrivateNetwork } from "../../ssrf-policy-Dhw9dwcN.js";
import { t as createLoggerBackedRuntime } from "../../runtime-logger-gFH0UxhU.js";
import { t as tlonPlugin } from "../../channel-DiMrMsES.js";

//#region extensions/tlon/src/runtime.d.ts
declare const setTlonRuntime: (next: PluginRuntime) => void, getTlonRuntime: () => PluginRuntime;
//#endregion
export { type LookupFn, type OpenClawConfig, type ReplyPayload, type RuntimeEnv, SsrFBlockedError, type SsrFPolicy, createDedupeCache, createLoggerBackedRuntime, fetchWithSsrFGuard, isBlockedHostnameOrIp, setTlonRuntime, ssrfPolicyFromAllowPrivateNetwork, ssrfPolicyFromDangerouslyAllowPrivateNetwork, tlonPlugin };