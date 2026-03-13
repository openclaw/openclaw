import type { ResolvedBrowserProfile } from "./config.js";
import type { BrowserTab, ProfileRuntimeState } from "./server-context.types.js";
type SelectionDeps = {
    profile: ResolvedBrowserProfile;
    getProfileState: () => ProfileRuntimeState;
    ensureBrowserAvailable: () => Promise<void>;
    listTabs: () => Promise<BrowserTab[]>;
    openTab: (url: string) => Promise<BrowserTab>;
};
type SelectionOps = {
    ensureTabAvailable: (targetId?: string) => Promise<BrowserTab>;
    focusTab: (targetId: string) => Promise<void>;
    closeTab: (targetId: string) => Promise<void>;
};
export declare function createProfileSelectionOps({ profile, getProfileState, ensureBrowserAvailable, listTabs, openTab, }: SelectionDeps): SelectionOps;
export {};
