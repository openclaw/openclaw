import type { BrowserRouteContext, ProfileStatus } from "./server-context.js";
export type CreateProfileParams = {
    name: string;
    color?: string;
    cdpUrl?: string;
    driver?: "openclaw" | "extension";
};
export type CreateProfileResult = {
    ok: true;
    profile: string;
    cdpPort: number;
    cdpUrl: string;
    color: string;
    isRemote: boolean;
};
export type DeleteProfileResult = {
    ok: true;
    profile: string;
    deleted: boolean;
};
export declare function createBrowserProfilesService(ctx: BrowserRouteContext): {
    listProfiles: () => Promise<ProfileStatus[]>;
    createProfile: (params: CreateProfileParams) => Promise<CreateProfileResult>;
    deleteProfile: (nameRaw: string) => Promise<DeleteProfileResult>;
};
