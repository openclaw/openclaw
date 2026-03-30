import type { ChannelOnboardingAdapter } from "../onboarding-types.js";
export declare function parseIMessageAllowFromEntries(raw: string): {
    entries: string[];
    error?: string;
};
export declare const imessageOnboardingAdapter: ChannelOnboardingAdapter;
