import { C as OpenClawPluginApi } from "../../types-Wr1dwNsu.js";
//#region extensions/acpx/index.d.ts
declare const plugin: {
  id: string;
  name: string;
  description: string;
  register(api: OpenClawPluginApi): void;
};
//#endregion
export { plugin as default };