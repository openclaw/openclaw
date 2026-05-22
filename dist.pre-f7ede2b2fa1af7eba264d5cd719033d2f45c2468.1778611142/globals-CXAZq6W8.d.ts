//#region src/global-state.d.ts
declare function setVerbose(v: boolean): void;
declare function isVerbose(): boolean;
declare function setYes(v: boolean): void;
declare function isYes(): boolean;
//#endregion
//#region src/globals.d.ts
declare function shouldLogVerbose(): boolean;
declare function logVerbose(message: string): void;
declare function logVerboseConsole(message: string): void;
type ThemeFormatter = (value: string) => string;
declare const success: ThemeFormatter;
declare const warn: ThemeFormatter;
declare const info: ThemeFormatter;
declare const danger: ThemeFormatter;
//#endregion
export { shouldLogVerbose as a, isVerbose as c, setYes as d, logVerboseConsole as i, isYes as l, info as n, success as o, logVerbose as r, warn as s, danger as t, setVerbose as u };