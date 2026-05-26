import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
//#region extensions/qwen/onboard.d.ts
declare function applyQwenProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
declare function applyQwenProviderConfigCn(cfg: OpenClawConfig): OpenClawConfig;
declare function applyQwenConfig(cfg: OpenClawConfig): OpenClawConfig;
declare function applyQwenConfigCn(cfg: OpenClawConfig): OpenClawConfig;
declare function applyQwenStandardProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
declare function applyQwenStandardProviderConfigCn(cfg: OpenClawConfig): OpenClawConfig;
declare function applyQwenStandardConfig(cfg: OpenClawConfig): OpenClawConfig;
declare function applyQwenStandardConfigCn(cfg: OpenClawConfig): OpenClawConfig;
declare const applyModelStudioProviderConfig: typeof applyQwenProviderConfig;
declare const applyModelStudioProviderConfigCn: typeof applyQwenProviderConfigCn;
declare const applyModelStudioConfig: typeof applyQwenConfig;
declare const applyModelStudioConfigCn: typeof applyQwenConfigCn;
declare const applyModelStudioStandardProviderConfig: typeof applyQwenStandardProviderConfig;
declare const applyModelStudioStandardProviderConfigCn: typeof applyQwenStandardProviderConfigCn;
declare const applyModelStudioStandardConfig: typeof applyQwenStandardConfig;
declare const applyModelStudioStandardConfigCn: typeof applyQwenStandardConfigCn;
//#endregion
export { applyModelStudioConfig, applyModelStudioConfigCn, applyModelStudioProviderConfig, applyModelStudioProviderConfigCn, applyModelStudioStandardConfig, applyModelStudioStandardConfigCn, applyModelStudioStandardProviderConfig, applyModelStudioStandardProviderConfigCn, applyQwenConfig, applyQwenConfigCn, applyQwenStandardConfig, applyQwenStandardConfigCn };