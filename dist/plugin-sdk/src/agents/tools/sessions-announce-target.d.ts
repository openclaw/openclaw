import type { AnnounceTarget } from "./sessions-send-helpers.js";
export declare function resolveAnnounceTarget(params: {
    sessionKey: string;
    displayKey: string;
}): Promise<AnnounceTarget | null>;
