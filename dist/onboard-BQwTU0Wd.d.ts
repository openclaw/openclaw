import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/nvidia/onboard.d.ts
declare const NVIDIA_DEFAULT_MODEL_REF = "nvidia/nemotron-3-super-120b-a12b";
declare function applyNvidiaProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
declare function applyNvidiaConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { applyNvidiaConfig as n, applyNvidiaProviderConfig as r, NVIDIA_DEFAULT_MODEL_REF as t };