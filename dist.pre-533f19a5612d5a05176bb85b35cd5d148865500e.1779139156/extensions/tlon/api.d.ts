import { i as OpenClawConfig } from "../../types.openclaw-Bpxi7OSY.js";
import { a as SsrFBlockedError, o as SsrFPolicy, p as isBlockedHostnameOrIp, t as LookupFn } from "../../ssrf-D7o7kbM-.js";
import { n as RuntimeEnv } from "../../runtime-BGU8SNjK.js";
import { r as ReplyPayload } from "../../reply-payload-FWjCVbzM.js";
import { n as PluginRuntime } from "../../types-Dsa-0Faj.js";
import { r as createDedupeCache } from "../../dedupe-CqDSG9Rn.js";
import { a as fetchWithSsrFGuard } from "../../fetch-guard-BrZJ1X5M.js";
import { d as ssrfPolicyFromDangerouslyAllowPrivateNetwork, u as ssrfPolicyFromAllowPrivateNetwork } from "../../ssrf-policy-C2iZeR4B.js";
import { t as createLoggerBackedRuntime } from "../../runtime-logger-DT_lLZgn.js";
import { t as tlonPlugin } from "../../channel-BCyaXN2o.js";

//#region extensions/tlon/src/runtime.d.ts
declare const setTlonRuntime: (next: PluginRuntime) => void, getTlonRuntime: () => PluginRuntime;
//#endregion
export { type LookupFn, type OpenClawConfig, type ReplyPayload, type RuntimeEnv, SsrFBlockedError, type SsrFPolicy, createDedupeCache, createLoggerBackedRuntime, fetchWithSsrFGuard, isBlockedHostnameOrIp, setTlonRuntime, ssrfPolicyFromAllowPrivateNetwork, ssrfPolicyFromDangerouslyAllowPrivateNetwork, tlonPlugin };