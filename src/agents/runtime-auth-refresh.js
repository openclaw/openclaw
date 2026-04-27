import { resolveSafeTimeoutDelayMs } from "../utils/timer-delay.js";
export function clampRuntimeAuthRefreshDelayMs(params) {
    return resolveSafeTimeoutDelayMs(params.refreshAt - params.now, { minMs: params.minDelayMs });
}
