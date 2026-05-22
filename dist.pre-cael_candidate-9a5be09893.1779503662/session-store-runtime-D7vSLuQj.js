import "./paths---FlWJ0A.js";
import { t as loadSessionStore$1 } from "./store-load-DM26fo1a.js";
import "./store-CuGD5gZu.js";
import "./reset-D9XwPMPN.js";
import "./session-key-C0qlw8ki.js";
import "./transcript-CkSJhWxP.js";
//#region src/plugin-sdk/session-store-runtime.ts
/**
* @deprecated Use getSessionEntry/listSessionEntries for reads and
* patchSessionEntry/upsertSessionEntry for writes. loadSessionStore keeps the
* legacy mutable whole-store shape and will remain a compatibility escape hatch.
*/
const loadSessionStore = loadSessionStore$1;
//#endregion
export { loadSessionStore as t };
