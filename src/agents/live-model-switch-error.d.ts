export type LiveSessionModelSelection = {
    provider: string;
    model: string;
    authProfileId?: string;
    authProfileIdSource?: "auto" | "user";
};
export declare class LiveSessionModelSwitchError extends Error {
    provider: string;
    model: string;
    authProfileId?: string;
    authProfileIdSource?: "auto" | "user";
    constructor(selection: LiveSessionModelSelection);
}
