import type { FailoverReason } from "./pi-embedded-helpers.js";
export declare function shouldAllowCooldownProbeForReason(reason: FailoverReason | null | undefined): boolean;
export declare function shouldUseTransientCooldownProbeSlot(reason: FailoverReason | null | undefined): boolean;
export declare function shouldPreserveTransientCooldownProbeSlot(reason: FailoverReason | null | undefined): boolean;
