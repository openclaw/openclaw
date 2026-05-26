import { f as loadSessionStore$1 } from "./store-hrETKlw2.js";
//#region src/plugin-sdk/config-runtime.d.ts
/**
 * @deprecated Use getSessionEntry/listSessionEntries for reads and
 * patchSessionEntry/upsertSessionEntry for writes. loadSessionStore keeps the
 * legacy mutable whole-store shape and will remain a compatibility escape hatch.
 */
declare const loadSessionStore: typeof loadSessionStore$1;
//#endregion
export { loadSessionStore as t };