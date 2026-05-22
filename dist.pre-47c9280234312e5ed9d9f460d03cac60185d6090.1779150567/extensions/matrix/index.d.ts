import { C as OpenClawPluginApi } from "../../types-B1YsHkjI.js";
import { n as ChannelPlugin } from "../../types.public-B24V6qkJ.js";
import { t as BundledChannelEntryContract } from "../../channel-entry-contract-CVRlCE6z.js";

//#region extensions/matrix/index.d.ts
declare function registerMatrixFullRuntime(api: OpenClawPluginApi): void;
declare const _default: BundledChannelEntryContract<ChannelPlugin>;
//#endregion
export { _default as default, registerMatrixFullRuntime };