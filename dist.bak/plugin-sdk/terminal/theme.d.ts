export declare const theme: {
    readonly accent: import("chalk").ChalkInstance;
    readonly accentBright: import("chalk").ChalkInstance;
    readonly accentDim: import("chalk").ChalkInstance;
    readonly info: import("chalk").ChalkInstance;
    readonly success: import("chalk").ChalkInstance;
    readonly warn: import("chalk").ChalkInstance;
    readonly error: import("chalk").ChalkInstance;
    readonly muted: import("chalk").ChalkInstance;
    readonly heading: import("chalk").ChalkInstance;
    readonly command: import("chalk").ChalkInstance;
    readonly option: import("chalk").ChalkInstance;
};
export declare const isRich: () => boolean;
export declare const colorize: (rich: boolean, color: (value: string) => string, value: string) => string;
