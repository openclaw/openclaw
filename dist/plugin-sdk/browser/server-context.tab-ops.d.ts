import type { ResolvedBrowserProfile } from "./config.js";
import type { BrowserServerState, BrowserTab, ProfileRuntimeState } from "./server-context.types.js";
type TabOpsDeps = {
    profile: ResolvedBrowserProfile;
    state: () => BrowserServerState;
    getProfileState: () => ProfileRuntimeState;
};
type ProfileTabOps = {
    listTabs: () => Promise<BrowserTab[]>;
    openTab: (url: string) => Promise<BrowserTab>;
};
export declare function createProfileTabOps({ profile, state, getProfileState, }: TabOpsDeps): ProfileTabOps;
export {};
