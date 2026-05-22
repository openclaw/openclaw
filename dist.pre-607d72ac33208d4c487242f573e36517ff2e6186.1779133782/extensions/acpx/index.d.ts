import { C as OpenClawPluginApi } from "../../types-XJr-3iEG.js";
//#region extensions/acpx/index.d.ts
declare const plugin: {
  id: string;
  name: string;
  description: string;
  register(api: OpenClawPluginApi): void;
};
//#endregion
export { plugin as default };