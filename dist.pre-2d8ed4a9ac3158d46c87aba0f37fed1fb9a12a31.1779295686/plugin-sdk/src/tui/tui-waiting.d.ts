type MinimalTheme = {
    dim: (s: string) => string;
    bold: (s: string) => string;
    accentSoft: (s: string) => string;
};
export declare const defaultWaitingPhrases: string[];
export declare function pickWaitingPhrase(tick: number, phrases?: string[]): string;
export declare function shimmerText(theme: MinimalTheme, text: string, tick: number): string;
export declare function buildWaitingStatusMessage(params: {
    theme: MinimalTheme;
    tick: number;
    elapsed: string;
    connectionStatus: string;
    phrases?: string[];
}): string;
export {};
