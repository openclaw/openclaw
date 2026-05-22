import { C as OpenClawPluginApi } from "../../types-Dw7_sm4q.js";
import { n as ChannelPlugin } from "../../types.public-Dt2dhO3I.js";
import { t as BundledChannelEntryContract } from "../../channel-entry-contract-GJzsCeMv.js";

//#region extensions/matrix/index.d.ts
declare function registerMatrixFullRuntime(api: OpenClawPluginApi): void;
declare const _default: BundledChannelEntryContract<ChannelPlugin>;
//#endregion
export { _default as default, registerMatrixFullRuntime };