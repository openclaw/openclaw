import "./paths-Bg3PO6Gj.js";
import { t as loadSessionStore$1 } from "./store-load-z4thf6ld.js";
import "./store-BmtchQvp.js";
import "./reset-B0OJOtNI.js";
import "./session-key-B2pwhP3C.js";
import "./transcript-BA0Ngd-A.js";
//#region src/plugin-sdk/session-store-runtime.ts
/**
* @deprecated Use getSessionEntry/listSessionEntries for reads and
* patchSessionEntry/upsertSessionEntry for writes. loadSessionStore keeps the
* legacy mutable whole-store shape and will remain a compatibility escape hatch.
*/
const loadSessionStore = loadSessionStore$1;
//#endregion
export { loadSessionStore as t };
