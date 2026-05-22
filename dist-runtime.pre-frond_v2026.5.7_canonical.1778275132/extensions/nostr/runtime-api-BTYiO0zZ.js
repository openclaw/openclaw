export * from "../../../dist/extensions/nostr/runtime-api-BTYiO0zZ.js";
import * as module from "../../../dist/extensions/nostr/runtime-api-BTYiO0zZ.js";
let defaultExport = "default" in module ? module.default : module;
for (let index = 0; index < 4 && defaultExport && typeof defaultExport === "object" && "default" in defaultExport; index += 1) {
  defaultExport = defaultExport.default;
}
export { defaultExport as default };
