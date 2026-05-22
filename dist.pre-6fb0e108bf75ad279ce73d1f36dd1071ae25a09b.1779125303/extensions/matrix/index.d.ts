import { C as OpenClawPluginApi } from "../../types-CPAF_tyr.js";
import { n as ChannelPlugin } from "../../types.public-Cx-Og-oG.js";
import { t as BundledChannelEntryContract } from "../../channel-entry-contract-BCeDLPjc.js";

//#region extensions/matrix/index.d.ts
declare function registerMatrixFullRuntime(api: OpenClawPluginApi): void;
declare const _default: BundledChannelEntryContract<ChannelPlugin>;
//#endregion
export { _default as default, registerMatrixFullRuntime };