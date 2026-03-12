import type { ChannelOnboardingAdapter } from "../onboarding-types.js";
export declare function normalizeSignalAccountInput(value: string | null | undefined): string | null;
export declare function parseSignalAllowFromEntries(raw: string): {
    entries: string[];
    error?: string;
};
export declare const signalOnboardingAdapter: ChannelOnboardingAdapter;
