import { i as OpenClawConfig } from "../../types.openclaw-BdZr8Ncl.js";
import { a as SsrFBlockedError, o as SsrFPolicy, p as isBlockedHostnameOrIp, t as LookupFn } from "../../ssrf-qTfRSneg.js";
import { n as RuntimeEnv } from "../../runtime-DRy59NVK.js";
import { r as ReplyPayload } from "../../reply-payload-B-IPpMUf.js";
import { n as PluginRuntime } from "../../types-4PahHl43.js";
import { r as createDedupeCache } from "../../dedupe-DDoCFpFk.js";
import { a as fetchWithSsrFGuard } from "../../fetch-guard-BazbOKNB.js";
import { d as ssrfPolicyFromAllowPrivateNetwork, f as ssrfPolicyFromDangerouslyAllowPrivateNetwork } from "../../ssrf-policy-NW1NCo6p.js";
import { t as createLoggerBackedRuntime } from "../../runtime-logger-VFYed0LD.js";
import { t as tlonPlugin } from "../../channel-B9RgSKil.js";

//#region extensions/tlon/src/runtime.d.ts
declare const setTlonRuntime: (next: PluginRuntime) => void, getTlonRuntime: () => PluginRuntime;
//#endregion
export { type LookupFn, type OpenClawConfig, type ReplyPayload, type RuntimeEnv, SsrFBlockedError, type SsrFPolicy, createDedupeCache, createLoggerBackedRuntime, fetchWithSsrFGuard, isBlockedHostnameOrIp, setTlonRuntime, ssrfPolicyFromAllowPrivateNetwork, ssrfPolicyFromDangerouslyAllowPrivateNetwork, tlonPlugin };