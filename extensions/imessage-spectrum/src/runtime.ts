import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

export type IMessageSpectrumRuntime = PluginRuntime;

const {
  setRuntime: setIMessageSpectrumRuntime,
  getRuntime: getIMessageSpectrumRuntime,
  tryGetRuntime: tryGetIMessageSpectrumRuntime,
  clearRuntime: clearIMessageSpectrumRuntime,
} = createPluginRuntimeStore<IMessageSpectrumRuntime>({
  pluginId: "imessage-spectrum",
  errorMessage: "iMessage Spectrum runtime not initialized",
});

export {
  clearIMessageSpectrumRuntime,
  getIMessageSpectrumRuntime,
  setIMessageSpectrumRuntime,
  tryGetIMessageSpectrumRuntime,
};
