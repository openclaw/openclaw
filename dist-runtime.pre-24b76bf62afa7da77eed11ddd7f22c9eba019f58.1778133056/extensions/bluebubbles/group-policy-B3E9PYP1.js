export * from "../../../dist/extensions/bluebubbles/group-policy-B3E9PYP1.js";
import * as module from "../../../dist/extensions/bluebubbles/group-policy-B3E9PYP1.js";
let defaultExport = "default" in module ? module.default : module;
for (let index = 0; index < 4 && defaultExport && typeof defaultExport === "object" && "default" in defaultExport; index += 1) {
  defaultExport = defaultExport.default;
}
export { defaultExport as default };
