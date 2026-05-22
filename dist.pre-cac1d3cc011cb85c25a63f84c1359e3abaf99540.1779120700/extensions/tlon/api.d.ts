import { i as OpenClawConfig } from "../../types.openclaw-C58U02FA.js";
import { a as SsrFBlockedError, o as SsrFPolicy, p as isBlockedHostnameOrIp, t as LookupFn } from "../../ssrf-BaAslmHK.js";
import { n as RuntimeEnv } from "../../runtime-lEKWbTQa.js";
import { r as ReplyPayload } from "../../reply-payload-DWEJrbEL.js";
import { n as PluginRuntime } from "../../types-taiLI91p.js";
import { r as createDedupeCache } from "../../dedupe-v_aBboCF.js";
import { a as fetchWithSsrFGuard } from "../../fetch-guard-DG95ojWq.js";
import { d as ssrfPolicyFromDangerouslyAllowPrivateNetwork, u as ssrfPolicyFromAllowPrivateNetwork } from "../../ssrf-policy-BEWlI-Ft.js";
import { t as createLoggerBackedRuntime } from "../../runtime-logger-DEV6-HWw.js";
import { t as tlonPlugin } from "../../channel-Bw28infN.js";

//#region extensions/tlon/src/runtime.d.ts
declare const setTlonRuntime: (next: PluginRuntime) => void, getTlonRuntime: () => PluginRuntime;
//#endregion
export { type LookupFn, type OpenClawConfig, type ReplyPayload, type RuntimeEnv, SsrFBlockedError, type SsrFPolicy, createDedupeCache, createLoggerBackedRuntime, fetchWithSsrFGuard, isBlockedHostnameOrIp, setTlonRuntime, ssrfPolicyFromAllowPrivateNetwork, ssrfPolicyFromDangerouslyAllowPrivateNetwork, tlonPlugin };