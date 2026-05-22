export * from "../../../dist/extensions/open-prose/index.js";
import defaultModule from "../../../dist/extensions/open-prose/index.js";
let defaultExport = defaultModule;
for (let index = 0; index < 4 && defaultExport && typeof defaultExport === "object" && "default" in defaultExport; index += 1) {
  defaultExport = defaultExport.default;
}
export { defaultExport as default };
