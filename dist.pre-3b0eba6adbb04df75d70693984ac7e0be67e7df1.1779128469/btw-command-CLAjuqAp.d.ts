import { s as CommandNormalizeOptions } from "./commands-registry.types--X5qKEEe.js";
//#region src/auto-reply/reply/abort-primitives.d.ts
declare function isAbortRequestText(text?: string, options?: CommandNormalizeOptions): boolean;
//#endregion
//#region src/auto-reply/reply/btw-command.d.ts
declare function isBtwRequestText(text?: string, options?: CommandNormalizeOptions): boolean;
//#endregion
export { isAbortRequestText as n, isBtwRequestText as t };