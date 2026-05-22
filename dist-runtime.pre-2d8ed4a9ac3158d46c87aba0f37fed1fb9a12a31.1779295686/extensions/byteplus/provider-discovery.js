export * from "../../../dist/extensions/byteplus/provider-discovery.js";
import defaultModule from "../../../dist/extensions/byteplus/provider-discovery.js";
let defaultExport = defaultModule;
for (let index = 0; index < 4 && defaultExport && typeof defaultExport === "object" && "default" in defaultExport; index += 1) {
  defaultExport = defaultExport.default;
}
export { defaultExport as default };
