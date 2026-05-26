import { s as ChannelSetupWizard } from "./setup-wizard-types-BKBpG8mO.js";
import { H as ChannelSetupAdapter } from "./types.adapters-y0dBEomF.js";
//#region src/plugin-sdk/optional-channel-setup.d.ts
type OptionalChannelSetupParams$1 = {
  channel: string;
  label: string;
  npmSpec?: string;
  docsPath?: string;
};
declare function createOptionalChannelSetupAdapter(params: OptionalChannelSetupParams$1): ChannelSetupAdapter;
declare function createOptionalChannelSetupWizard(params: OptionalChannelSetupParams$1): ChannelSetupWizard;
//#endregion
//#region src/plugin-sdk/channel-setup.d.ts
/** Metadata used to advertise an optional channel plugin during setup flows. */
type OptionalChannelSetupParams = {
  channel: string;
  label: string;
  npmSpec?: string;
  docsPath?: string;
};
/** Paired setup adapter + setup wizard for channels that may not be installed yet. */
type OptionalChannelSetupSurface = {
  setupAdapter: ChannelSetupAdapter;
  setupWizard: ChannelSetupWizard;
};
/** Build both optional setup surfaces from one metadata object. */
declare function createOptionalChannelSetupSurface(params: OptionalChannelSetupParams): OptionalChannelSetupSurface;
//#endregion
export { createOptionalChannelSetupWizard as i, createOptionalChannelSetupSurface as n, createOptionalChannelSetupAdapter as r, OptionalChannelSetupSurface as t };