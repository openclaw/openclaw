import { i as OpenClawConfig } from "../../types.openclaw-DPnlcagS.js";
import { a as SsrFBlockedError, o as SsrFPolicy, p as isBlockedHostnameOrIp, t as LookupFn } from "../../ssrf-C9NFk_3M.js";
import { n as RuntimeEnv } from "../../runtime-BvGYzQ2u.js";
import { r as ReplyPayload } from "../../reply-payload-DmUUsX03.js";
import { n as PluginRuntime } from "../../types-CvAaVTok.js";
import { r as createDedupeCache } from "../../dedupe-CM03D0WY.js";
import { a as fetchWithSsrFGuard } from "../../fetch-guard-DlNZ6eLr.js";
import { d as ssrfPolicyFromDangerouslyAllowPrivateNetwork, u as ssrfPolicyFromAllowPrivateNetwork } from "../../ssrf-policy-DPD28b9m.js";
import { t as createLoggerBackedRuntime } from "../../runtime-logger-EiaNks22.js";
import { t as tlonPlugin } from "../../channel-SVsABGAZ.js";

//#region extensions/tlon/src/runtime.d.ts
declare const setTlonRuntime: (next: PluginRuntime) => void, getTlonRuntime: () => PluginRuntime;
//#endregion
export { type LookupFn, type OpenClawConfig, type ReplyPayload, type RuntimeEnv, SsrFBlockedError, type SsrFPolicy, createDedupeCache, createLoggerBackedRuntime, fetchWithSsrFGuard, isBlockedHostnameOrIp, setTlonRuntime, ssrfPolicyFromAllowPrivateNetwork, ssrfPolicyFromDangerouslyAllowPrivateNetwork, tlonPlugin };